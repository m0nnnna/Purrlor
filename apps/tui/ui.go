package main

import (
	"errors"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/id"
)

const directID = id.RoomID("direct")

type screen int

const (
	scrLogin screen = iota
	scrConnecting
	scrChat
)

type options struct{ compact, noBell bool }

type model struct {
	prog  *tea.Program
	opts  options
	w, h  int
	scr   screen
	tick  int
	sess  *Session
	be    *Backend
	st    *Store
	ready bool

	// login
	fields   [3]textinput.Model
	focus    int
	busy     bool
	loginErr string

	// chat
	spaces    []id.RoomID
	curSpace  id.RoomID
	curRoom   id.RoomID
	lastRoom  map[id.RoomID]id.RoomID
	composer  textinput.Model
	scroll    int
	sel       int
	status    string
	statusAt  time.Time
	lastKey   time.Time
	lastTyped time.Time
	prevHL    int
	jump      bool
	jumpIn    textinput.Model
	jumpSel   int
	replyTo   id.EventID // composer is replying to this message
	editing   id.EventID // composer is editing this message
	reacting  bool       // reaction picker is open for the selected message
	delArmed  id.EventID // "d" pressed once on this message; again deletes it
	sbHits    []sbHit    // what each visible sidebar row is, for mouse clicks
	sideW     int
}

type tickMsg time.Time
type loginDoneMsg struct {
	sess *Session
	err  error
}
type backendMsg struct {
	be  *Backend
	err error
}
type backfillMsg struct {
	room id.RoomID
	err  error
}
type actionMsg struct {
	status string
	err    error
}

func newModel(opts options, sess *Session) *model {
	m := &model{opts: opts, sess: sess, lastKey: time.Now(), lastRoom: map[id.RoomID]id.RoomID{}}
	mk := func(ph, val string) textinput.Model {
		t := textinput.New()
		t.Placeholder = ph
		t.SetValue(val)
		t.Prompt = ""
		return t
	}
	m.fields[0] = mk("https://purr.meowops.net", "https://purr.meowops.net")
	m.fields[1] = mk("username", "")
	m.fields[2] = mk("password", "")
	m.fields[2].EchoMode = textinput.EchoPassword
	m.fields[0].Focus()
	m.composer = textinput.New()
	m.composer.Prompt = "> "
	m.composer.Focus()
	m.composer.CharLimit = 4000
	m.jumpIn = textinput.New()
	m.jumpIn.Prompt = ""
	if sess != nil {
		m.scr = scrConnecting
	}
	return m
}

func tickCmd() tea.Cmd {
	return tea.Tick(250*time.Millisecond, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m *model) Init() tea.Cmd {
	cmds := []tea.Cmd{textinput.Blink, tickCmd()}
	if m.sess != nil {
		cmds = append(cmds, m.connectCmd(m.sess))
	}
	return tea.Batch(cmds...)
}

func (m *model) connectCmd(s *Session) tea.Cmd {
	return func() tea.Msg {
		be, err := newBackend(s)
		return backendMsg{be, err}
	}
}

func (m *model) setStatus(s string) { m.status, m.statusAt = s, time.Now() }

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m.st != nil {
		m.st.mu.Lock()
		defer m.st.mu.Unlock()
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
	case tickMsg:
		m.tick++
		if m.status != "" && time.Since(m.statusAt) > 6*time.Second {
			m.status = ""
		}
		return m, tickCmd()
	case loginDoneMsg:
		m.busy = false
		if msg.err != nil {
			m.loginErr = msg.err.Error()
			return m, nil
		}
		if err := saveSession(msg.sess); err != nil {
			m.loginErr = "login ok but couldn't save session: " + err.Error()
		}
		m.sess, m.scr = msg.sess, scrConnecting
		return m, m.connectCmd(msg.sess)
	case backendMsg:
		if msg.err != nil {
			m.scr, m.loginErr = scrLogin, msg.err.Error()
			return m, nil
		}
		m.be, m.st, m.scr = msg.be, msg.be.st, scrChat
		m.be.Start(m.prog)
		return m, nil
	case syncErrMsg:
		if errors.Is(msg.err, mautrix.MUnknownToken) {
			clearSession()
			m.scr, m.loginErr, m.sess = scrLogin, "session expired — please log in again", nil
			return m, nil
		}
		m.setStatus("sync error: " + msg.err.Error())
	case syncMsg:
		return m, m.onSync(msg)
	case backfillMsg:
		if msg.err != nil {
			m.setStatus("history: " + msg.err.Error())
			if r := m.st.rooms[msg.room]; r != nil {
				r.Loading = false
			}
		}
		return m, m.receiptCmd()
	case actionMsg:
		if msg.err != nil {
			m.setStatus("error: " + msg.err.Error())
		} else if msg.status != "" {
			m.setStatus(msg.status)
		}
	case tea.MouseMsg:
		if m.scr == scrChat {
			return m, m.mouse(msg)
		}
	case tea.KeyMsg:
		m.lastKey = time.Now()
		switch m.scr {
		case scrLogin:
			return m.loginKey(msg)
		case scrChat:
			return m.chatKey(msg)
		default:
			if msg.String() == "ctrl+c" {
				return m, tea.Quit
			}
		}
	}
	return m, nil
}

// ---------- login ----------

func (m *model) loginKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "ctrl+c", "esc":
		return m, tea.Quit
	case "tab", "down", "enter", "shift+tab", "up":
		s := k.String()
		if s == "enter" && m.focus == 2 && !m.busy {
			hs, u, p := m.fields[0].Value(), strings.TrimSpace(m.fields[1].Value()), m.fields[2].Value()
			if u == "" || p == "" {
				m.loginErr = "username and password required"
				return m, nil
			}
			m.busy, m.loginErr = true, ""
			return m, func() tea.Msg {
				ctx, cancel := ctxTimeout(45 * time.Second)
				defer cancel()
				s, err := doLogin(ctx, hs, u, p)
				return loginDoneMsg{s, err}
			}
		}
		d := 1
		if s == "shift+tab" || s == "up" {
			d = -1
		}
		m.fields[m.focus].Blur()
		m.focus = (m.focus + d + 3) % 3
		m.fields[m.focus].Focus()
		return m, nil
	}
	var cmd tea.Cmd
	m.fields[m.focus], cmd = m.fields[m.focus].Update(k)
	return m, cmd
}

func (m *model) loginView() string {
	if m.w == 0 {
		return ""
	}
	labels := []string{"homeserver", "username  ", "password  "}
	var l []string
	l = append(l, accent.Render("  =^.^=  purrlor"), dim.Render("  a cozy terminal for your servers"), "")
	for i, f := range m.fields {
		lab := dim.Render(labels[i])
		if i == m.focus {
			lab = accent.Render(labels[i])
		}
		l = append(l, lab+"  "+f.View())
	}
	l = append(l, "")
	switch {
	case m.busy:
		l = append(l, dim.Render("logging in… ᓚᘏᗢ"))
	case m.loginErr != "":
		l = append(l, warn.Render(m.loginErr))
	default:
		l = append(l, dim.Render("Tab: next field · Enter: log in · Esc: quit"))
	}
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.Color("240")).Padding(1, 3).Render(strings.Join(l, "\n"))
	return lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center, box)
}

// ---------- room/space bookkeeping (call with st.mu held) ----------

func (m *model) spaceList() []id.RoomID {
	var sp []*Room
	for _, r := range m.st.rooms {
		if r.IsSpace && !r.Hidden && !r.Invited {
			sp = append(sp, r)
		}
	}
	sort.Slice(sp, func(i, j int) bool { return m.roomLess(sp[i], sp[j]) })
	out := []id.RoomID{directID}
	for _, r := range sp {
		out = append(out, r.ID)
	}
	return out
}

func (m *model) channelsOf(space id.RoomID) []id.RoomID {
	inSpace := map[id.RoomID]bool{}
	for _, r := range m.st.rooms {
		if r.IsSpace {
			for c := range r.Children {
				inSpace[c] = true
			}
		}
	}
	var out []*Room
	for _, r := range m.st.rooms {
		if r.IsSpace || r.Hidden || r.ChanType == "feed" {
			continue
		}
		if space == directID {
			if inSpace[r.ID] {
				continue
			}
		} else if sr := m.st.rooms[space]; sr == nil || !sr.Children[r.ID] {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		vi, vj := out[i].ChanType == "voice", out[j].ChanType == "voice"
		if vi != vj {
			return vj
		}
		return m.roomLess(out[i], out[j])
	})
	ids := make([]id.RoomID, len(out))
	for i, r := range out {
		ids[i] = r.ID
	}
	return ids
}

// roomLess orders rooms by name, then by origin server and room ID, so two federated rooms that
// share a name (two "general"s) keep their places instead of swapping on every sync.
func (m *model) roomLess(a, b *Room) bool {
	na, nb := strings.ToLower(m.st.roomName(a)), strings.ToLower(m.st.roomName(b))
	if na != nb {
		return na < nb
	}
	if sa, sb := roomOrigin(a), roomOrigin(b); sa != sb {
		return sa < sb
	}
	return a.ID < b.ID
}

// roomOrigin is the server a room comes from: its alias's server, else the server in its ID
// (room versions before 12 have one), else the end of the ID so it's still told apart.
func roomOrigin(r *Room) string {
	if i := strings.LastIndexByte(r.Alias, ':'); i >= 0 {
		return shortServer(r.Alias[i+1:])
	}
	if i := strings.IndexByte(string(r.ID), ':'); i >= 0 {
		return shortServer(string(r.ID)[i+1:])
	}
	if s := string(r.ID); len(s) > 5 {
		return "…" + s[len(s)-4:]
	}
	return string(r.ID)
}

func shortServer(s string) string {
	for _, p := range []string{"matrix.", "chat.", "synapse.", "conduit.", "continuwuity."} {
		if t := strings.TrimPrefix(s, p); t != s && strings.Contains(t, ".") {
			return t
		}
	}
	return s
}

// roomTag marks a room whose name another visible room also has with where it comes from,
// e.g. "general · meowops.net"; "" when the name is unique.
func (m *model) roomTag(r *Room) string {
	name := strings.ToLower(m.st.roomName(r))
	for _, o := range m.st.rooms {
		if o.ID != r.ID && !o.Hidden && !o.Invited && o.IsSpace == r.IsSpace && strings.ToLower(m.st.roomName(o)) == name {
			return " · " + roomOrigin(r)
		}
	}
	return ""
}

func indexOf(l []id.RoomID, x id.RoomID) int {
	for i, v := range l {
		if v == x {
			return i
		}
	}
	return -1
}

func (m *model) onSync(s syncMsg) tea.Cmd {
	m.spaces = m.spaceList()
	if s.ready {
		m.ready = true
	}
	var cmds []tea.Cmd
	if m.ready {
		if indexOf(m.spaces, m.curSpace) < 0 {
			m.curSpace = directID
			if len(m.spaces) > 1 {
				m.curSpace = m.spaces[1]
			}
			m.curRoom = ""
		}
		chs := m.channelsOf(m.curSpace)
		if indexOf(chs, m.curRoom) < 0 && len(chs) > 0 {
			target := chs[0]
			if lr := m.lastRoom[m.curSpace]; indexOf(chs, lr) >= 0 {
				target = lr
			}
			cmds = append(cmds, m.enterRoom(target))
		}
	}
	if hl := m.totalHighlight(); hl > m.prevHL && !m.opts.noBell {
		fmt.Fprint(os.Stdout, "\a")
		m.prevHL = hl
	} else {
		m.prevHL = hl
	}
	cmds = append(cmds, m.receiptCmd())
	return tea.Batch(cmds...)
}

func (m *model) enterRoom(rid id.RoomID) tea.Cmd {
	m.curRoom, m.scroll, m.sel = rid, 0, 0
	m.lastRoom[m.curSpace] = rid
	r := m.st.rooms[rid]
	if r == nil {
		return nil
	}
	cmds := []tea.Cmd{m.receiptCmd()}
	if !r.Loaded && !r.Loading && !r.Invited {
		cmds = append(cmds, m.backfillCmd(r))
	}
	return tea.Batch(cmds...)
}

func (m *model) backfillCmd(r *Room) tea.Cmd {
	r.Loading = true
	rid, from, be := r.ID, r.PrevBatch, m.be
	return func() tea.Msg {
		_, err := be.Backfill(rid, from)
		return backfillMsg{rid, err}
	}
}

func (m *model) receiptCmd() tea.Cmd {
	r := m.st.rooms[m.curRoom]
	if r == nil || r.Invited {
		return nil
	}
	r.Unread, r.Highlight = 0, 0
	if len(r.Msgs) == 0 {
		return nil
	}
	last := r.Msgs[len(r.Msgs)-1].ID
	if last == r.LastReceipt {
		return nil
	}
	r.LastReceipt = last
	rid, be := r.ID, m.be
	return func() tea.Msg { be.Receipt(rid, last); return nil }
}

func (m *model) cycleChannel(d int) tea.Cmd {
	chs := m.channelsOf(m.curSpace)
	if len(chs) == 0 {
		return nil
	}
	i := (indexOf(chs, m.curRoom) + d + len(chs)) % len(chs)
	return m.enterRoom(chs[i])
}

func (m *model) cycleSpace(d int) tea.Cmd {
	m.spaces = m.spaceList()
	if len(m.spaces) == 0 {
		return nil
	}
	return m.gotoSpace((indexOf(m.spaces, m.curSpace) + d + len(m.spaces)) % len(m.spaces))
}

// gotoSpace opens the i-th space in the sidebar (0-based), at the channel last open there.
func (m *model) gotoSpace(i int) tea.Cmd {
	m.spaces = m.spaceList()
	if i < 0 || i >= len(m.spaces) {
		return nil
	}
	m.curSpace = m.spaces[i]
	chs := m.channelsOf(m.curSpace)
	if len(chs) == 0 {
		m.curRoom = ""
		return nil
	}
	t := chs[0]
	if lr := m.lastRoom[m.curSpace]; indexOf(chs, lr) >= 0 {
		t = lr
	}
	return m.enterRoom(t)
}

// ---------- jump ----------

type jumpItem struct {
	label       string
	space, room id.RoomID
	score       int
}

func fuzzy(q, s string) (int, bool) {
	q, s = strings.ToLower(q), strings.ToLower(s)
	score, pos := 0, 0
	for _, c := range q {
		i := strings.IndexRune(s[pos:], c)
		if i < 0 {
			return 0, false
		}
		score += i
		pos += i + len(string(c))
	}
	return score, true
}

func (m *model) jumpMatches() []jumpItem {
	var out []jumpItem
	for _, sp := range m.spaceList() {
		sname := "Direct"
		if sp != directID {
			sname = m.st.roomName(m.st.rooms[sp]) + m.roomTag(m.st.rooms[sp])
		}
		for _, c := range m.channelsOf(sp) {
			r := m.st.rooms[c]
			name := m.st.roomName(r)
			sc, ok := fuzzy(m.jumpIn.Value(), name)
			if !ok {
				continue
			}
			out = append(out, jumpItem{label: m.chanLabel(r) + dim.Render("  "+sname), space: sp, room: c, score: sc})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score < out[j].score })
	return out
}

func (m *model) jumpKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	ms := m.jumpMatches()
	switch k.String() {
	case "esc", "ctrl+k", "ctrl+c":
		m.jump = false
		return m, nil
	case "up":
		if m.jumpSel > 0 {
			m.jumpSel--
		}
		return m, nil
	case "down", "tab":
		if m.jumpSel < len(ms)-1 {
			m.jumpSel++
		}
		return m, nil
	case "enter":
		m.jump = false
		if m.jumpSel < len(ms) {
			m.curSpace = ms[m.jumpSel].space
			return m, m.enterRoom(ms[m.jumpSel].room)
		}
		return m, nil
	}
	var cmd tea.Cmd
	m.jumpIn, cmd = m.jumpIn.Update(k)
	m.jumpSel = 0
	return m, cmd
}

// ---------- chat input ----------

func (m *model) target(r *Room) *Msg {
	if r == nil || len(r.Msgs) == 0 {
		return nil
	}
	if m.sel > 0 && m.sel <= len(r.Msgs) {
		return r.Msgs[len(r.Msgs)-m.sel]
	}
	return r.Msgs[len(r.Msgs)-1]
}

func (m *model) chatKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.jump {
		return m.jumpKey(k)
	}
	r := m.st.rooms[m.curRoom]
	page := m.h - 8
	if page < 3 {
		page = 3
	}
	if mdl, cmd, ok := m.msgActionKey(r, k); ok {
		return mdl, cmd
	}
	switch k.String() {
	case "ctrl+c":
		return m, m.quit()
	case "ctrl+k":
		m.jump, m.jumpSel = true, 0
		m.jumpIn.SetValue("")
		m.jumpIn.Focus()
		return m, nil
	case "tab", "alt+down":
		return m, m.cycleChannel(1)
	case "shift+tab", "alt+up":
		return m, m.cycleChannel(-1)
	case "ctrl+down", "alt+right", "ctrl+n":
		return m, m.cycleSpace(1)
	case "ctrl+up", "alt+left", "ctrl+p":
		return m, m.cycleSpace(-1)
	case "alt+1", "alt+2", "alt+3", "alt+4", "alt+5", "alt+6", "alt+7", "alt+8", "alt+9":
		return m, m.gotoSpace(int(k.String()[4] - '1'))
	case "pgup":
		if r == nil {
			return m, nil
		}
		total := len(m.chatLines(r, m.w-26))
		m.scroll += page
		if max := total - page; m.scroll >= max {
			m.scroll = max
			if m.scroll < 0 {
				m.scroll = 0
			}
			if !r.Exhausted && !r.Loading {
				return m, m.backfillCmd(r)
			}
		}
		return m, nil
	case "pgdown":
		m.scroll -= page
		if m.scroll < 0 {
			m.scroll = 0
		}
		return m, nil
	case "up":
		if r != nil && m.sel < len(r.Msgs) {
			m.sel++
		}
		return m, nil
	case "down":
		if m.sel > 0 {
			m.sel--
		}
		return m, nil
	case "esc":
		m.sel, m.scroll = 0, 0
		if m.editing != "" {
			m.composer.SetValue("")
		}
		m.replyTo, m.editing, m.reacting, m.delArmed = "", "", false, ""
		return m, nil
	case "alt+o":
		return m, m.openCmd(r)
	case "enter":
		text := strings.TrimSpace(m.composer.Value())
		m.composer.SetValue("")
		if text == "" {
			return m, nil
		}
		return m, m.submit(r, text)
	}
	var cmd tea.Cmd
	m.composer, cmd = m.composer.Update(k)
	if r != nil && m.composer.Value() != "" && time.Since(m.lastTyped) > 4*time.Second && !strings.HasPrefix(m.composer.Value(), "/") {
		m.lastTyped = time.Now()
		rid, be := r.ID, m.be
		return m, tea.Batch(cmd, func() tea.Msg { be.Typing(rid, true); return nil })
	}
	return m, cmd
}

func (m *model) quit() tea.Cmd {
	if m.be != nil {
		m.be.Stop()
	}
	return tea.Quit
}

func (m *model) openCmd(r *Room) tea.Cmd {
	var t *Msg
	if r != nil {
		if m.sel > 0 {
			t = m.target(r)
		} else {
			for i := len(r.Msgs) - 1; i >= 0; i-- {
				if k := r.Msgs[i].Kind; k == "image" || k == "file" {
					t = r.Msgs[i]
					break
				}
			}
		}
	}
	if t == nil || (t.Kind != "image" && t.Kind != "file") {
		m.setStatus("no image/file to open")
		return nil
	}
	cp, be := *t, m.be
	m.setStatus("downloading " + cp.FileName + "…")
	return func() tea.Msg {
		if err := be.OpenAttachment(cp); err != nil {
			return actionMsg{err: err}
		}
		return actionMsg{status: "opened " + cp.FileName}
	}
}

var cats = []string{
	" /\\_/\\\n( o.o )\n > ^ <",
	" /\\_/\\\n( ^.^ )\n(\")_(\")",
	"  |\\---/|\n  | o_o |\n   \\_^_/",
	" /\\___/\\\n(  =w=  )\n (\")   (\")",
	"  ,_     _,\n  |\\\\___//|\n  |=6   6=|\n  \\=._Y_.=/\n   )  `  (    ,\n  /       \\  ((\n  |       |   ))\n /| |   | |\\_//\n \\| |._.| |/-`\n  '\"'   '\"'",
	"    /\\_/\\  (\n   ( ^.^ ) _)\n     \\\"/  (\n   ( | | )\n  (__d b__)",
	" |\\__/,|   (`\\\n |_ _  |.--.) )\n ( T   )     /\n(((^_(((/(((_/",
	"   _._     _,-'\"\"`-._\n  (,-.`._,'(       |\\`-/|\n      `-.-' \\ )-`( , o o)\n            `-    \\`_`\"'-",
}

func (m *model) submit(r *Room, text string) tea.Cmd {
	if r == nil {
		m.setStatus("no channel selected")
		return nil
	}
	be, rid := m.be, r.ID
	send := func(c func() error, ok string) tea.Cmd {
		return func() tea.Msg { return actionMsg{status: ok, err: c()} }
	}
	if err := be.canSend(r); err != nil {
		m.setStatus(err.Error())
		return nil
	}
	if r.Invited && text != "/join" && text != "/quit" {
		m.setStatus("not joined yet — type /join")
		return nil
	}
	t := m.target(r)
	var reply id.EventID
	if strings.HasPrefix(text, "/") {
		cmd, arg, _ := strings.Cut(text, " ")
		arg = strings.TrimSpace(arg)
		switch cmd {
		case "/quit", "/q":
			return m.quit()
		case "/help":
			m.setStatus("Spaces: click, Alt+1-9, Alt+←/→ · channels: click, Tab/Shift+Tab, Ctrl+K · /me /react /reply /purr /open /join /quit")
			return nil
		case "/join":
			return send(func() error { return be.Join(rid) }, "joined")
		case "/open":
			return m.openCmd(r)
		case "/purr":
			art := cats[rand.Intn(len(cats))]
			return send(func() error { return be.Send(rid, buildArt(art)) }, "")
		case "/me":
			if arg == "" {
				return nil
			}
			return send(func() error { return be.Send(rid, buildText(arg, true, "")) }, "")
		case "/react":
			if t == nil || arg == "" {
				m.setStatus("usage: /react <emoji> (reacts to the selected or last message)")
				return nil
			}
			m.sel = 0
			return m.toggleReact(r, t, arg)
		case "/reply":
			if t == nil || arg == "" {
				m.setStatus("usage: /reply <text>")
				return nil
			}
			reply, text = t.ID, arg
		default:
			m.setStatus("unknown command " + cmd + " — try /help")
			return nil
		}
	} else if m.editing != "" {
		eid := m.editing
		m.editing, m.sel, m.scroll = "", 0, 0
		return send(func() error { return be.Edit(rid, eid, text) }, "edited")
	} else if m.replyTo != "" {
		reply = m.replyTo
	}
	m.replyTo, m.sel, m.scroll = "", 0, 0
	body := text
	go be.Typing(rid, false)
	return send(func() error { return be.Send(rid, buildText(body, false, reply)) }, "")
}

func (m *model) View() string {
	switch m.scr {
	case scrLogin:
		return m.loginView()
	case scrConnecting:
		if m.w == 0 {
			return ""
		}
		return lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center,
			accent.Render("=^.^=")+"  "+dim.Render("connecting…"))
	}
	return m.chatView()
}

// mouse: a left click on a sidebar row opens that space or channel; the wheel scrolls the chat.
func (m *model) mouse(e tea.MouseMsg) tea.Cmd {
	switch {
	case e.Button == tea.MouseButtonWheelUp:
		return m.scrollKey("pgup")
	case e.Button == tea.MouseButtonWheelDown:
		return m.scrollKey("pgdown")
	case e.Button != tea.MouseButtonLeft || e.Action != tea.MouseActionPress:
		return nil
	}
	row := e.Y - 1 // the header takes the first line
	if m.jump || e.X < 1 || e.X > m.sideW || row < 0 || row >= len(m.sbHits) {
		return nil
	}
	h := m.sbHits[row]
	switch {
	case h.room != "":
		return m.enterRoom(h.room)
	case h.space != "":
		return m.gotoSpace(indexOf(m.spaceList(), h.space))
	}
	return nil
}

func (m *model) scrollKey(key string) tea.Cmd {
	_, cmd := m.chatKey(tea.KeyMsg{Type: map[string]tea.KeyType{"pgup": tea.KeyPgUp, "pgdown": tea.KeyPgDown}[key]})
	return cmd
}

// ---------- message actions ----------

var quickReacts = []string{"👍", "❤️", "😂", "🐾", "😮", "😢"}

// msgActionKey handles the one-letter actions on a message picked with ↑ (only while the
// composer is empty, so typing still works), and the reaction picker. ok=false: not handled.
func (m *model) msgActionKey(r *Room, k tea.KeyMsg) (tea.Model, tea.Cmd, bool) {
	if r == nil || m.sel == 0 {
		return m, nil, false
	}
	t := m.target(r)
	if t == nil {
		return m, nil, false
	}
	key := k.String()
	if m.reacting {
		switch {
		case key == "esc":
			m.reacting = false
			m.composer.SetValue("")
			return m, nil, true
		case len(key) == 1 && key[0] >= '1' && key[0] < '1'+byte(len(quickReacts)) && m.composer.Value() == "":
			m.reacting, m.sel = false, 0
			return m, m.toggleReact(r, t, quickReacts[key[0]-'1']), true
		case key == "enter":
			e := strings.TrimSpace(m.composer.Value())
			m.composer.SetValue("")
			m.reacting = false
			if e == "" {
				return m, nil, true
			}
			m.sel = 0
			return m, m.toggleReact(r, t, e), true
		}
		return m, nil, false // typing a custom emoji into the composer
	}
	if m.composer.Value() != "" {
		return m, nil, false
	}
	mine := t.Sender == m.st.me
	if key != "d" {
		m.delArmed = ""
	}
	switch key {
	case "r", "enter":
		m.replyTo, m.editing, m.sel = t.ID, "", 0
		return m, nil, true
	case "e", "+":
		m.reacting = true
		return m, nil, true
	case "i":
		if !mine || (t.Kind != "text" && t.Kind != "emote" && t.Kind != "notice") {
			m.setStatus("you can only edit your own text messages")
			return m, nil, true
		}
		m.editing, m.replyTo, m.sel = t.ID, "", 0
		m.composer.SetValue(t.Body)
		m.composer.CursorEnd()
		return m, nil, true
	case "d", "delete":
		if !mine {
			m.setStatus("you can only delete your own messages")
			return m, nil, true
		}
		if m.delArmed != t.ID {
			m.delArmed = t.ID
			m.setStatus("press d again to delete this message")
			return m, nil, true
		}
		m.delArmed, m.sel = "", 0
		rid, eid, be := r.ID, t.ID, m.be
		return m, func() tea.Msg { return actionMsg{status: "deleted", err: be.Redact(rid, eid)} }, true
	case "y":
		body := t.Body
		if t.Kind == "image" || t.Kind == "file" {
			body = t.FileName
		}
		return m, func() tea.Msg {
			c := exec.Command("wl-copy")
			c.Stdin = strings.NewReader(body)
			if err := c.Run(); err != nil {
				return actionMsg{err: fmt.Errorf("copy needs wl-copy: %w", err)}
			}
			return actionMsg{status: "copied"}
		}, true
	case "o":
		return m, m.openCmd(r), true
	}
	return m, nil, false
}

// toggleReact adds a reaction, or takes yours back if you'd already reacted with it.
func (m *model) toggleReact(r *Room, t *Msg, key string) tea.Cmd {
	rid, tid, be := r.ID, t.ID, m.be
	if mine, ok := r.Reacts[tid][key][m.st.me]; ok && mine != "" {
		return func() tea.Msg { return actionMsg{err: be.Redact(rid, mine)} }
	}
	return func() tea.Msg { return actionMsg{err: be.React(rid, tid, key)} }
}

// actionHint is the status line while a message is picked, replied to or edited.
func (m *model) actionHint(r *Room) string {
	switch {
	case r == nil:
		return ""
	case m.reacting:
		var b strings.Builder
		for i, e := range quickReacts {
			fmt.Fprintf(&b, "%d %s  ", i+1, e)
		}
		return "react: " + b.String() + "· or type any emoji + Enter · Esc cancel"
	case m.sel > 0:
		t := m.target(r)
		if t == nil {
			return ""
		}
		h := "r reply · e react"
		if t.Sender == m.st.me {
			h += " · i edit · d delete"
		}
		if t.Kind == "image" || t.Kind == "file" {
			h += " · o open"
		}
		return h + " · y copy · ↑↓ pick · Esc done"
	}
	return ""
}

// composerPrefix shows what Enter will do when it isn't a plain message.
func (m *model) composerPrefix(r *Room) string {
	switch {
	case r == nil:
	case m.editing != "":
		return accent.Render("✎ editing ")
	case m.replyTo != "":
		if x := r.byID[m.replyTo]; x != nil {
			return accent.Render("↳ " + r.userName(x.Sender) + " ")
		}
		return accent.Render("↳ ")
	}
	return ""
}
