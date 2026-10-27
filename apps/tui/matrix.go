package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto/cryptohelper"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/format"
	"maunium.net/go/mautrix/id"
	_ "modernc.org/sqlite"
)

// ---------- data model ----------

type Msg struct {
	ID       id.EventID
	Sender   id.UserID
	TS       time.Time
	Kind     string // text, emote, notice, image, file, encrypted
	Body     string
	FileName string
	URL      id.ContentURIString
	File     *event.EncryptedFileInfo
	ReplyTo  id.EventID
	Edited   bool
	EditTS   time.Time
}

type pendingEdit struct {
	TS     time.Time
	Sender id.UserID
	C      *event.MessageEventContent
}

type Room struct {
	ID        id.RoomID
	Name      string
	Alias     string
	IsSpace   bool
	Hidden    bool
	ChanType  string
	ModOnly   bool
	Encrypted bool
	Invited   bool
	JoinedCnt int

	Children map[id.RoomID]bool
	Parents  map[id.RoomID]bool
	Names    map[id.UserID]string
	Members  map[id.UserID]bool

	Msgs   []*Msg
	byID   map[id.EventID]*Msg
	Reacts map[id.EventID]map[string]map[id.UserID]id.EventID
	Edits  map[id.EventID]*pendingEdit
	Typing []id.UserID

	Unread, Highlight int
	PrevBatch         string
	Exhausted         bool
	Loaded, Loading   bool
	LastReceipt       id.EventID
}

type Store struct {
	mu        sync.RWMutex
	rooms     map[id.RoomID]*Room
	direct    map[id.RoomID]bool
	me        id.UserID
	dirty     atomic.Bool
	firstSync atomic.Int64 // unix nano of first sync response
}

func newStore(me id.UserID) *Store {
	return &Store{rooms: map[id.RoomID]*Room{}, direct: map[id.RoomID]bool{}, me: me}
}

func (s *Store) room(rid id.RoomID) *Room {
	r := s.rooms[rid]
	if r == nil {
		r = &Room{ID: rid, Children: map[id.RoomID]bool{}, Parents: map[id.RoomID]bool{},
			Names: map[id.UserID]string{}, Members: map[id.UserID]bool{},
			byID: map[id.EventID]*Msg{}, Reacts: map[id.EventID]map[string]map[id.UserID]id.EventID{},
			Edits: map[id.EventID]*pendingEdit{}}
		s.rooms[rid] = r
	}
	return r
}

func localpart(u id.UserID) string {
	s := strings.TrimPrefix(string(u), "@")
	if i := strings.Index(s, ":"); i >= 0 {
		s = s[:i]
	}
	return s
}

func (r *Room) userName(u id.UserID) string {
	if n := r.Names[u]; n != "" {
		return n
	}
	return localpart(u)
}

func (s *Store) roomName(r *Room) string {
	if r.Name != "" {
		return r.Name
	}
	if r.Alias != "" {
		return strings.TrimPrefix(r.Alias, "#")
	}
	var others []string
	for u := range r.Members {
		if u != s.me {
			others = append(others, r.userName(u))
		}
	}
	sort.Strings(others)
	if len(others) > 0 {
		return strings.Join(others, ", ")
	}
	return string(r.ID)
}

func (r *Room) insert(m *Msg) {
	if old := r.byID[m.ID]; old != nil {
		if old.Kind == "encrypted" && m.Kind != "encrypted" {
			*old = *m
			r.applyPending(old)
		}
		return
	}
	r.byID[m.ID] = m
	i := sort.Search(len(r.Msgs), func(i int) bool { return r.Msgs[i].TS.After(m.TS) })
	r.Msgs = append(r.Msgs, nil)
	copy(r.Msgs[i+1:], r.Msgs[i:])
	r.Msgs[i] = m
	r.applyPending(m)
}

func (r *Room) applyPending(m *Msg) {
	if e := r.Edits[m.ID]; e != nil {
		r.applyEdit(m, e)
	}
}

func (r *Room) applyEdit(m *Msg, e *pendingEdit) {
	if e.Sender != m.Sender || !e.TS.After(m.EditTS) || e.C == nil {
		return
	}
	m.EditTS, m.Edited = e.TS, true
	fillMsg(m, e.C)
}

func fillMsg(m *Msg, c *event.MessageEventContent) {
	m.Body = c.Body
	switch c.MsgType {
	case event.MsgEmote:
		m.Kind = "emote"
	case event.MsgNotice:
		m.Kind = "notice"
	case event.MsgImage:
		m.Kind = "image"
	case event.MsgFile, event.MsgVideo, event.MsgAudio:
		m.Kind = "file"
	default:
		m.Kind = "text"
	}
	if m.Kind == "image" || m.Kind == "file" {
		m.FileName = c.FileName
		if m.FileName == "" {
			m.FileName = c.Body
		}
		m.URL, m.File = c.URL, c.File // not GetFile(): it invents an empty File for plain uploads
	}
}

func rawJSON(evt *event.Event, v any) bool {
	b := []byte(evt.Content.VeryRaw)
	if len(b) == 0 {
		b, _ = json.Marshal(evt.Content.Raw)
	}
	return json.Unmarshal(b, v) == nil
}

// process applies one event to the store. Caller must hold s.mu for writing.
func (s *Store) process(evt *event.Event) {
	t := evt.Type.Type
	if evt.RoomID == "" {
		if t == "m.direct" {
			if dc := evt.Content.AsDirectChats(); dc != nil {
				for _, rooms := range *dc {
					for _, rid := range rooms {
						s.direct[rid] = true
					}
				}
			}
		}
		return
	}
	r := s.room(evt.RoomID)
	src := evt.Mautrix.EventSource
	if src&event.SourceJoin != 0 {
		r.Invited = false
	}
	if src&event.SourceLeave != 0 && evt.StateKey != nil && id.UserID(*evt.StateKey) == s.me {
		delete(s.rooms, r.ID)
		return
	}
	switch t {
	case "m.room.create":
		if c := evt.Content.AsCreate(); c != nil {
			switch string(c.Type) {
			case "m.space":
				r.IsSpace = true
			case "xyz.nekous.emote_library", "xyz.nekous.profile":
				r.Hidden = true
			}
		}
	case "m.room.name":
		var c struct {
			Name string `json:"name"`
		}
		rawJSON(evt, &c)
		r.Name = c.Name
	case "m.room.canonical_alias":
		var c struct {
			Alias string `json:"alias"`
		}
		rawJSON(evt, &c)
		r.Alias = c.Alias
	case "m.room.encryption":
		r.Encrypted = true
	case "m.space.child":
		if evt.StateKey != nil {
			child := id.RoomID(*evt.StateKey)
			var c struct {
				Via []string `json:"via"`
			}
			rawJSON(evt, &c)
			if len(c.Via) > 0 {
				r.IsSpace = true
				r.Children[child] = true
			} else {
				delete(r.Children, child)
			}
		}
	case "m.space.parent":
		if evt.StateKey != nil {
			r.Parents[id.RoomID(*evt.StateKey)] = true
		}
	case "xyz.nekous.channel_type":
		var c struct {
			Type string `json:"type"`
		}
		if rawJSON(evt, &c) {
			r.ChanType = c.Type
		}
	case "xyz.nekous.channel_settings":
		var c struct {
			ModOnly bool `json:"moderators_only"`
		}
		if rawJSON(evt, &c) {
			r.ModOnly = c.ModOnly
		}
	case "m.room.member":
		if evt.StateKey == nil {
			return
		}
		u := id.UserID(*evt.StateKey)
		mc := evt.Content.AsMember()
		if mc.Displayname != "" {
			r.Names[u] = mc.Displayname
		}
		switch mc.Membership {
		case event.MembershipJoin, event.MembershipInvite:
			r.Members[u] = true
			if u == s.me && mc.Membership == event.MembershipInvite && src&event.SourceInvite != 0 {
				r.Invited = true
			}
		default:
			delete(r.Members, u)
		}
	case "m.typing":
		if tc := evt.Content.AsTyping(); tc != nil {
			r.Typing = tc.UserIDs
		}
	case "m.room.message", "m.room.encrypted", "m.reaction", "m.room.redaction", "m.sticker":
		s.processTimeline(r, evt)
	}
}

func (s *Store) processTimeline(r *Room, evt *event.Event) {
	ts := time.UnixMilli(evt.Timestamp)
	switch evt.Type.Type {
	case "m.room.encrypted":
		r.insert(&Msg{ID: evt.ID, Sender: evt.Sender, TS: ts, Kind: "encrypted"})
	case "m.reaction":
		rc := evt.Content.AsReaction()
		if rc == nil || rc.RelatesTo.EventID == "" {
			return
		}
		byKey := r.Reacts[rc.RelatesTo.EventID]
		if byKey == nil {
			byKey = map[string]map[id.UserID]id.EventID{}
			r.Reacts[rc.RelatesTo.EventID] = byKey
		}
		if byKey[rc.RelatesTo.Key] == nil {
			byKey[rc.RelatesTo.Key] = map[id.UserID]id.EventID{}
		}
		byKey[rc.RelatesTo.Key][evt.Sender] = evt.ID
	case "m.room.redaction":
		target := evt.Redacts
		if target == "" {
			if rc := evt.Content.AsRedaction(); rc != nil {
				target = rc.Redacts
			}
		}
		if target == "" {
			return
		}
		if m := r.byID[target]; m != nil {
			delete(r.byID, target)
			for i, x := range r.Msgs {
				if x == m {
					r.Msgs = append(r.Msgs[:i], r.Msgs[i+1:]...)
					break
				}
			}
			return
		}
		for _, byKey := range r.Reacts {
			for k, users := range byKey {
				for u, eid := range users {
					if eid == target {
						delete(users, u)
					}
				}
				if len(users) == 0 {
					delete(byKey, k)
				}
			}
		}
	default:
		c := evt.Content.AsMessage()
		if c == nil || (c.MsgType == "" && c.Body == "") {
			return // redacted / empty
		}
		if c.RelatesTo != nil && c.RelatesTo.GetReplaceID() != "" {
			target := c.RelatesTo.GetReplaceID()
			nc := c.NewContent
			if nc == nil {
				nc = c
			}
			e := &pendingEdit{TS: ts, Sender: evt.Sender, C: nc}
			if old := r.Edits[target]; old == nil || ts.After(old.TS) {
				r.Edits[target] = e
			}
			if m := r.byID[target]; m != nil {
				r.applyEdit(m, e)
			}
			return
		}
		m := &Msg{ID: evt.ID, Sender: evt.Sender, TS: ts}
		if c.RelatesTo != nil {
			if rt := c.RelatesTo.GetReplyTo(); rt != "" {
				m.ReplyTo = rt
				c.RemoveReplyFallback()
			}
		}
		fillMsg(m, c)
		if evt.Type.Type == "m.sticker" {
			m.Kind, m.FileName, m.URL = "image", c.Body, c.URL
		}
		r.insert(m)
	}
}

// ---------- session / login ----------

type Session struct {
	Homeserver  string `json:"homeserver"`
	UserID      string `json:"user_id"`
	DeviceID    string `json:"device_id"`
	AccessToken string `json:"access_token"`
	PickleKey   string `json:"pickle_key"`
}

func configDir() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(d, "purrlor")
}

func dataDir() string {
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "purrlor")
	}
	return filepath.Join(os.Getenv("HOME"), ".local", "share", "purrlor")
}

func sessionPath() string  { return filepath.Join(configDir(), "session.json") }
func cryptoDBPath() string { return filepath.Join(dataDir(), "crypto.db") }

func loadSession() *Session {
	b, err := os.ReadFile(sessionPath())
	if err != nil {
		return nil
	}
	var s Session
	if json.Unmarshal(b, &s) != nil || s.AccessToken == "" {
		return nil
	}
	return &s
}

func saveSession(s *Session) error {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(sessionPath(), b, 0o600)
}

func clearSession() {
	os.Remove(sessionPath())
	for _, suf := range []string{"", "-wal", "-shm"} {
		os.Remove(cryptoDBPath() + suf)
	}
}

func resolveHomeserver(ctx context.Context, in string) string {
	in = strings.TrimSpace(in)
	if in == "" {
		in = "https://purr.meowops.net"
	}
	if !strings.Contains(in, "://") {
		in = "https://" + in
	}
	u, err := url.Parse(in)
	if err != nil || u.Host == "" {
		return in
	}
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	// A Purrlor site (e.g. purr.meowops.net) is the web client, not the homeserver: its
	// /config.json names the homeserver it's locked to (apps/web/src/app/runtimeConfig.ts).
	if hs := purrlorConfigHomeserver(cctx, u); hs != "" {
		return strings.TrimRight(hs, "/")
	}
	if wk, err := mautrix.DiscoverClientAPI(cctx, u.Host); err == nil && wk != nil && wk.Homeserver.BaseURL != "" {
		return strings.TrimRight(wk.Homeserver.BaseURL, "/")
	}
	return strings.TrimRight(in, "/")
}

func doLogin(ctx context.Context, hsIn, user, pass string) (*Session, error) {
	hs := resolveHomeserver(ctx, hsIn)
	cli, err := mautrix.NewClient(hs, "", "")
	if err != nil {
		return nil, err
	}
	resp, err := cli.Login(ctx, &mautrix.ReqLogin{
		Type:                     mautrix.AuthTypePassword,
		Identifier:               mautrix.UserIdentifier{Type: mautrix.IdentifierTypeUser, User: user},
		Password:                 pass,
		InitialDeviceDisplayName: "Purrlor TUI",
	})
	if err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	rand.Read(key)
	clearSession() // drop any stale crypto db from a previous device
	return &Session{Homeserver: hs, UserID: string(resp.UserID), DeviceID: string(resp.DeviceID),
		AccessToken: resp.AccessToken, PickleKey: hex.EncodeToString(key)}, nil
}

// ---------- backend ----------

type syncMsg struct{ ready bool }
type syncErrMsg struct{ err error }

type Backend struct {
	cli       *mautrix.Client
	ch        *cryptohelper.CryptoHelper
	st        *Store
	cancel    context.CancelFunc
	CryptoErr string
}

func newBackend(sess *Session) (*Backend, error) {
	cli, err := mautrix.NewClient(sess.Homeserver, id.UserID(sess.UserID), sess.AccessToken)
	if err != nil {
		return nil, err
	}
	cli.DeviceID = id.DeviceID(sess.DeviceID)
	cli.Log = zerologNop()
	// Learn the server's spec versions, so media downloads use the authenticated
	// /_matrix/client/v1/media API that current servers require.
	vctx, vcancel := context.WithTimeout(context.Background(), 15*time.Second)
	_, _ = cli.Versions(vctx)
	vcancel()
	st := newStore(cli.UserID)
	b := &Backend{cli: cli, st: st}

	syncer := cli.Syncer.(*mautrix.DefaultSyncer)
	lazy := &mautrix.FilterPart{LazyLoadMembers: true}
	syncer.FilterJSON = &mautrix.Filter{
		Room: &mautrix.RoomFilter{
			Timeline: &mautrix.FilterPart{Limit: 30, LazyLoadMembers: true},
			State:    lazy,
		},
		Presence: &mautrix.FilterPart{NotTypes: []event.Type{{Type: "*"}}},
	}

	// E2EE (pure-Go olm via the goolm build tag, pure-Go sqlite via modernc).
	if err := os.MkdirAll(dataDir(), 0o700); err == nil {
		b.CryptoErr = b.initCrypto(sess)
	} else {
		b.CryptoErr = err.Error()
	}
	// The crypto store doubles as a sync token store; we keep room state in
	// memory only, so always do a full (filtered) initial sync.
	cli.Store = mautrix.NewMemorySyncStore()

	syncer.OnEvent(func(ctx context.Context, evt *event.Event) {
		st.mu.Lock()
		st.process(evt)
		st.mu.Unlock()
		st.dirty.Store(true)
	})
	syncer.OnSync(func(ctx context.Context, resp *mautrix.RespSync, since string) bool {
		st.mu.Lock()
		for rid, jr := range resp.Rooms.Join {
			r := st.room(rid)
			if jr.UnreadNotifications != nil {
				r.Unread, r.Highlight = jr.UnreadNotifications.NotificationCount, jr.UnreadNotifications.HighlightCount
			}
			if jr.Summary.JoinedMemberCount != nil {
				r.JoinedCnt = *jr.Summary.JoinedMemberCount
			}
			if r.PrevBatch == "" && !r.Loaded {
				r.PrevBatch = jr.Timeline.PrevBatch
			}
		}
		st.mu.Unlock()
		st.firstSync.CompareAndSwap(0, time.Now().UnixNano())
		st.dirty.Store(true)
		return true
	})
	return b, nil
}

func (b *Backend) initCrypto(sess *Session) string {
	db, err := sql.Open("sqlite", "file:"+cryptoDBPath()+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)")
	if err != nil {
		return err.Error()
	}
	wrapped, err := dbutil.NewWithDB(db, "sqlite")
	if err != nil {
		return err.Error()
	}
	pk, _ := hex.DecodeString(sess.PickleKey)
	ch, err := cryptohelper.NewCryptoHelper(b.cli, pk, wrapped)
	if err != nil {
		return err.Error()
	}
	ch.DBAccountID = sess.UserID
	if err := ch.Init(context.Background()); err != nil {
		return err.Error()
	}
	b.cli.Crypto = ch
	b.ch = ch
	return ""
}

func (b *Backend) Start(p *tea.Program) {
	ctx, cancel := context.WithCancel(context.Background())
	b.cancel = cancel
	go func() {
		err := b.cli.SyncWithContext(ctx)
		if err != nil && ctx.Err() == nil {
			p.Send(syncErrMsg{err})
		}
	}()
	go func() {
		t := time.NewTicker(150 * time.Millisecond)
		defer t.Stop()
		readySent := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				fs := b.st.firstSync.Load()
				ready := fs != 0 && time.Since(time.Unix(0, fs)) > 1500*time.Millisecond
				if b.st.dirty.Swap(false) || (ready && !readySent) {
					readySent = readySent || ready
					p.Send(syncMsg{ready: ready})
				}
			}
		}
	}()
}

func (b *Backend) Stop() {
	if b.cancel != nil {
		b.cancel()
	}
	if b.ch != nil {
		b.ch.Close()
	}
}

func (b *Backend) Logout() { b.cli.Logout(context.Background()) }

// ---- actions (run from tea.Cmds; never call with st.mu held) ----

func (b *Backend) Backfill(rid id.RoomID, from string) (n int, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := b.cli.Messages(ctx, rid, from, "", mautrix.DirectionBackward, nil, 50)
	if err != nil {
		return 0, err
	}
	var evts []*event.Event
	for _, e := range resp.Chunk {
		e.RoomID = rid
		if e.StateKey != nil {
			e.Type.Class = event.StateEventType
		} else {
			e.Type.Class = event.MessageEventType
		}
		_ = e.Content.ParseRaw(e.Type)
		if e.Type == event.EventEncrypted && b.cli.Crypto != nil {
			if d, derr := b.cli.Crypto.Decrypt(ctx, e); derr == nil {
				e = d
				e.RoomID = rid
			}
		}
		evts = append(evts, e)
	}
	b.st.mu.Lock()
	defer b.st.mu.Unlock()
	r := b.st.room(rid)
	r.Loading, r.Loaded = false, true
	for _, e := range evts {
		b.st.process(e)
	}
	r.PrevBatch = resp.End
	if resp.End == "" || len(resp.Chunk) == 0 {
		r.Exhausted = true
	}
	b.st.dirty.Store(true)
	return len(evts), nil
}

func (b *Backend) canSend(r *Room) error {
	if r.Encrypted && b.ch == nil {
		return errors.New("encrypted room and E2EE is unavailable: " + b.CryptoErr)
	}
	return nil
}

func (b *Backend) Send(rid id.RoomID, c *event.MessageEventContent) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, err := b.cli.SendMessageEvent(ctx, rid, event.EventMessage, c)
	return err
}

func buildText(text string, emote bool, replyTo id.EventID) *event.MessageEventContent {
	c := format.RenderMarkdown(text, true, false)
	if emote {
		c.MsgType = event.MsgEmote
	}
	if replyTo != "" {
		c.RelatesTo = (&event.RelatesTo{}).SetReplyTo(replyTo)
	}
	return &c
}

func buildArt(art string) *event.MessageEventContent {
	return &event.MessageEventContent{MsgType: event.MsgText, Body: art, Format: event.FormatHTML,
		FormattedBody: "<pre>" + html.EscapeString(art) + "</pre>"}
}

func (b *Backend) React(rid id.RoomID, target id.EventID, key string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := b.cli.SendMessageEvent(ctx, rid, event.EventReaction, &event.ReactionEventContent{
		RelatesTo: event.RelatesTo{Type: event.RelAnnotation, EventID: target, Key: key}})
	return err
}

// Edit replaces one of your own messages (m.replace).
func (b *Backend) Edit(rid id.RoomID, target id.EventID, text string) error {
	c := buildText(text, false, "")
	c.SetEdit(target)
	return b.Send(rid, c)
}

// Redact deletes an event: a message of yours, or your own reaction.
func (b *Backend) Redact(rid id.RoomID, target id.EventID) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := b.cli.RedactEvent(ctx, rid, target)
	return err
}

func (b *Backend) Receipt(rid id.RoomID, eid id.EventID) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = b.cli.MarkRead(ctx, rid, eid)
}

func (b *Backend) Typing(rid id.RoomID, on bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _ = b.cli.UserTyping(ctx, rid, on, 6*time.Second)
}

func (b *Backend) Join(rid id.RoomID) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := b.cli.JoinRoomByID(ctx, rid)
	return err
}

func (b *Backend) OpenAttachment(m Msg) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	uri := m.URL
	if m.File != nil && m.File.URL != "" {
		uri = m.File.URL
	}
	if uri == "" {
		return errors.New("this message has no file to download")
	}
	mxc, err := id.ParseContentURI(string(uri))
	if err != nil {
		return err
	}
	data, err := b.cli.DownloadBytes(ctx, mxc)
	if err != nil {
		return err
	}
	if m.File != nil && m.File.URL != "" {
		if err := m.File.PrepareForDecryption(); err != nil {
			return err
		}
		if data, err = m.File.Decrypt(data); err != nil {
			return err
		}
	}
	dir, err := os.MkdirTemp("", "purrlor-")
	if err != nil {
		return err
	}
	name := filepath.Base(m.FileName)
	if name == "" || name == "." || name == "/" {
		name = "attachment"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return exec.Command("xdg-open", path).Start()
}

var _ = fmt.Sprint

// purrlorConfigHomeserver reads the "homeserver" field of a Purrlor deployment's /config.json.
// Anything else (not a Purrlor site, the SPA's HTML fallback, an empty field) gives "".
func purrlorConfigHomeserver(ctx context.Context, site *url.URL) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, site.Scheme+"://"+site.Host+"/config.json", nil)
	if err != nil {
		return ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var cfg struct {
		Homeserver string `json:"homeserver"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&cfg) != nil {
		return ""
	}
	if !strings.HasPrefix(cfg.Homeserver, "https://") && !strings.HasPrefix(cfg.Homeserver, "http://") {
		return ""
	}
	return cfg.Homeserver
}
