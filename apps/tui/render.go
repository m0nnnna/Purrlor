package main

import (
	"fmt"
	"hash/fnv"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"maunium.net/go/mautrix/id"
)

var (
	dim      = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	bold     = lipgloss.NewStyle().Bold(true)
	border   = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	accent   = lipgloss.NewStyle().Foreground(lipgloss.Color("213")).Bold(true)
	warn     = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true)
	selStyle = lipgloss.NewStyle().Reverse(true)
	palette  = []string{"203", "209", "214", "149", "114", "79", "81", "75", "111", "141", "177", "212"}
)

func nameStyle(u id.UserID) lipgloss.Style {
	h := fnv.New32a()
	h.Write([]byte(u))
	return lipgloss.NewStyle().Foreground(lipgloss.Color(palette[int(h.Sum32())%len(palette)])).Bold(true)
}

// fit truncates or pads s to exactly w cells.
func fit(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if lipgloss.Width(s) > w {
		s = ansi.Truncate(s, w, "…")
	}
	if p := w - lipgloss.Width(s); p > 0 {
		s += strings.Repeat(" ", p)
	}
	return s
}

func hline(n int) string {
	if n < 0 {
		n = 0
	}
	return strings.Repeat("─", n)
}

// chatLines renders all of a room's messages to display lines.
func (m *model) chatLines(r *Room, width int) []string {
	nameW := 4
	for _, x := range r.Msgs {
		if l := lipgloss.Width(r.userName(x.Sender)); l > nameW {
			nameW = l
		}
	}
	if nameW > 14 {
		nameW = 14
	}
	var out []string
	for i, x := range r.Msgs {
		name := r.userName(x.Sender)
		ns := nameStyle(x.Sender)
		ts := x.TS.Local().Format("15:04")
		if m.sel > 0 && i == len(r.Msgs)-m.sel {
			ts = selStyle.Render(ts)
		} else {
			ts = dim.Render(ts)
		}
		body := x.Body
		switch x.Kind {
		case "image", "file":
			body = "[" + x.FileName + "] " + dim.Render("(o)pen")
		case "encrypted":
			body = dim.Render("🔒 encrypted (can't decrypt yet)")
		case "emote":
			body = ns.Render("* "+name) + " " + x.Body
		case "notice":
			body = dim.Render(x.Body)
		}
		if x.Edited {
			body += dim.Render(" (edited)")
		}
		reacts := reactionText(r, x, m.st.me)
		var reply string
		if x.ReplyTo != "" {
			if t := r.byID[x.ReplyTo]; t != nil {
				reply = "↳ replying to " + r.userName(t.Sender)
			} else {
				reply = "↳ replying to a message"
			}
		}
		if m.opts.compact {
			pre := ts + " " + ns.Render("<"+name+">") + " "
			if reply != "" {
				pre += dim.Render("(re " + strings.TrimPrefix(reply, "↳ replying to ") + ") ")
			}
			if reacts != "" {
				body += " " + dim.Render("["+reacts+"]")
			}
			out = append(out, strings.Split(ansi.Wrap(pre+body, width, ""), "\n")...)
			continue
		}
		pw := 5 + 1 + nameW + 2
		ind := strings.Repeat(" ", pw)
		if reply != "" {
			out = append(out, ind+dim.Render(reply))
		}
		bw := width - pw
		if bw < 10 {
			bw = 10
		}
		lines := strings.Split(ansi.Wrap(body, bw, ""), "\n")
		nm := ns.Render(fit(name, nameW))
		if x.Kind == "emote" {
			nm = strings.Repeat(" ", nameW)
		}
		for j, l := range lines {
			if j == 0 {
				out = append(out, ts+" "+nm+"  "+l)
			} else {
				out = append(out, ind+l)
			}
		}
		if reacts != "" {
			out = append(out, ind+dim.Render("↳ ")+reacts)
		}
	}
	return out
}

func reactionText(r *Room, x *Msg, me id.UserID) string {
	byKey := r.Reacts[x.ID]
	if len(byKey) == 0 {
		return ""
	}
	type kv struct {
		k    string
		n    int
		mine bool
	}
	var l []kv
	for k, users := range byKey {
		_, mine := users[me]
		l = append(l, kv{k, len(users), mine})
	}
	sort.Slice(l, func(i, j int) bool {
		if l[i].n != l[j].n {
			return l[i].n > l[j].n
		}
		return l[i].k < l[j].k
	})
	var parts []string
	for _, e := range l {
		s := e.k + " " + strconv.Itoa(e.n)
		if e.mine {
			s = accent.Render(s)
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "  ")
}

type sbLine struct {
	text string
	sel  bool
	hit  sbHit
}

type sbHit struct{ space, room id.RoomID }

func (m *model) roomBadge(r *Room) (string, int) {
	switch {
	case r.Highlight > 0:
		s := " " + strconv.Itoa(r.Highlight)
		return warn.Render(s), lipgloss.Width(s)
	case r.Unread > 0:
		return accent.Render(" •"), 2
	}
	return "", 0
}

func (m *model) chanLabel(r *Room) string {
	icon := "#"
	switch {
	case r.ChanType == "voice":
		icon = "🔊"
	case r.ModOnly:
		icon = "📣"
	case r.ChanType == "feed":
		icon = "📰"
	case m.st.direct[r.ID]:
		icon = "@"
	}
	return icon + " " + m.st.roomName(r) + dim.Render(m.roomTag(r))
}

func (m *model) sidebar(w, h int) []string {
	var lines []sbLine
	for si, sid := range m.spaces {
		var name string
		unread := false
		if sid == directID {
			name = "Direct"
			for _, c := range m.channelsOf(directID) {
				unread = unread || m.st.rooms[c].Unread > 0
			}
		} else {
			r := m.st.rooms[sid]
			name = m.st.roomName(r) + dim.Render(m.roomTag(r))
			for c := range r.Children {
				if cr := m.st.rooms[c]; cr != nil && cr.Unread > 0 {
					unread = true
				}
			}
		}
		num := " "
		if si < 9 {
			num = string(rune('1' + si))
		}
		pre := dim.Render(num) + "  "
		if sid == m.curSpace {
			pre = accent.Render(num + " ▸")
			name = bold.Render(name)
		}
		suffix := ""
		if unread {
			suffix = accent.Render(" •")
		}
		lines = append(lines, sbLine{text: pre + " " + fit(name, w-5-lipgloss.Width(suffix)) + suffix, hit: sbHit{space: sid}})
	}
	lines = append(lines, sbLine{text: dim.Render(fit(" Alt+1-9 · Alt+←→", w))})
	lines = append(lines, sbLine{text: dim.Render(hline(w))})
	selLine := 0
	for _, cid := range m.channelsOf(m.curSpace) {
		r := m.st.rooms[cid]
		badge, bw := m.roomBadge(r)
		label := fit(m.chanLabel(r), w-bw-1)
		if r.Unread > 0 {
			label = bold.Render(label)
		}
		sel := cid == m.curRoom
		if sel {
			selLine = len(lines)
			label = selStyle.Render(ansi.Strip(label))
		}
		lines = append(lines, sbLine{text: " " + label + badge, sel: sel, hit: sbHit{room: cid}})
	}
	start := 0
	if len(lines) > h {
		start = selLine - h/2
		if start < 0 {
			start = 0
		}
		if start > len(lines)-h {
			start = len(lines) - h
		}
	}
	var out []string
	m.sbHits = m.sbHits[:0]
	for i := start; i < len(lines) && i < start+h; i++ {
		out = append(out, lines[i].text)
		m.sbHits = append(m.sbHits, lines[i].hit)
	}
	return out
}

func (m *model) catFace() string {
	switch {
	case m.totalHighlight() > 0:
		return "=O.O="
	case time.Since(m.lastKey) > 5*time.Minute:
		return "=-.-="
	}
	return "=^.^="
}

func (m *model) totalHighlight() int {
	n := 0
	for _, r := range m.st.rooms {
		if !r.Hidden && !r.Invited {
			n += r.Highlight
		}
	}
	return n
}

func (m *model) chatView() string {
	W, H := m.w, m.h
	if W < 50 || H < 10 {
		return "terminal too small — make it bigger, nya"
	}
	m.st.mu.RLock()
	defer m.st.mu.RUnlock()
	sideW := 22
	if W < 80 {
		sideW = 16
	}
	m.sideW = sideW
	chatW := W - sideW - 3
	bodyH := H - 5
	msgH := bodyH - 3
	b := func(s string) string { return border.Render(s) }

	// header
	host := strings.TrimPrefix(strings.TrimPrefix(m.sess.Homeserver, "https://"), "http://")
	left := b("┌ ") + accent.Render("purrlor") + b(" ─ ") + dim.Render(host) + b(" ")
	right := b(" ") + accent.Render(m.catFace()) + " " + bold.Render(localpart(m.st.me)) + b(" ┐")
	fill := W - lipgloss.Width(left) - lipgloss.Width(right)
	var rows []string
	rows = append(rows, left+b(hline(fill))+right)

	side := m.sidebar(sideW, bodyH)
	chat := make([]string, bodyH)
	r := m.st.rooms[m.curRoom]
	if r == nil {
		chat[0] = dim.Render(" no channel selected")
		if len(m.st.rooms) == 0 {
			chat[1] = dim.Render(" waiting for rooms…")
		}
	} else {
		title := bold.Render(" " + m.chanLabel(r))
		info := ""
		if r.JoinedCnt > 0 {
			info = fmt.Sprintf("%d members", r.JoinedCnt)
		}
		if r.Encrypted {
			info += " 🔒"
		}
		if r.ChanType == "voice" {
			info = "🔊 voice (no audio here) · " + info
		}
		info = dim.Render(info + " ")
		gap := chatW - lipgloss.Width(title) - lipgloss.Width(info)
		if gap < 1 {
			gap = 1
		}
		chat[0] = title + strings.Repeat(" ", gap) + info
		chat[1] = b(hline(chatW))
		var body []string
		if m.jump {
			body = m.jumpLines(chatW, msgH)
		} else if r.Invited {
			body = []string{"", dim.Render("  You're invited to this room. Type /join to accept.")}
		} else {
			all := m.chatLines(r, chatW)
			end := len(all) - m.scroll
			if end < 0 {
				end = 0
			}
			start := end - msgH
			if start < 0 {
				start = 0
			}
			body = all[start:end]
			if len(all) == 0 && r.Loading {
				body = []string{dim.Render("  fetching history…")}
			}
			if pad := msgH - len(body); pad > 0 {
				body = append(make([]string, pad), body...)
			}
		}
		copy(chat[2:], body)
		typing := ""
		var who []string
		for _, u := range r.Typing {
			if u != m.st.me {
				who = append(who, r.userName(u))
			}
		}
		switch len(who) {
		case 0:
		case 1, 2, 3:
			typing = " " + strings.Join(who, ", ") + " is typing… "
			if len(who) > 1 {
				typing = " " + strings.Join(who, ", ") + " are typing… "
			}
		default:
			typing = " several people are typing… "
		}
		if m.scroll > 0 {
			typing += fmt.Sprintf("(↑ scrolled %d) ", m.scroll)
		}
		chat[bodyH-1] = b("───") + dim.Render(typing) + b(hline(chatW-3-lipgloss.Width(typing)))
	}
	for i := 0; i < bodyH; i++ {
		sl := ""
		if i < len(side) {
			sl = side[i]
		}
		rows = append(rows, b("│")+fit(sl, sideW)+b("│")+fit(chat[i], chatW)+b("│"))
	}
	rows = append(rows, b("├"+hline(sideW)+"┼"+hline(chatW)+"┤"))
	rows = append(rows, b("│")+fit(dim.Render(" ^K jump · Tab"), sideW)+b("│")+fit(m.composerView(chatW), chatW)+b("│"))
	rows = append(rows, b("└"+hline(sideW)+"┴"+hline(chatW)+"┘"))
	rows = append(rows, m.statusBar(W))
	return strings.Join(rows, "\n")
}

func (m *model) composerView(w int) string {
	pre := m.composerPrefix(m.st.rooms[m.curRoom])
	m.composer.Width = w - 4 - lipgloss.Width(pre)
	if m.jump {
		return dim.Render(" > (jumping…)")
	}
	return " " + pre + m.composer.View()
}

func (m *model) statusBar(w int) string {
	if !m.ready {
		const cat = "ᓚᘏᗢ"
		span := w - 24
		if span < 1 {
			span = 1
		}
		p := m.tick % (2 * span)
		if p >= span {
			p = 2*span - p
		}
		return strings.Repeat(" ", p) + accent.Render(cat) + dim.Render(" syncing…")
	}
	s := m.status
	if h := m.actionHint(m.st.rooms[m.curRoom]); h != "" && (s == "" || m.reacting) {
		s = h
	}
	if s == "" {
		s = "click or Alt+1-9 space · Tab channel · ^K jump · PgUp/PgDn scroll · ↑ select msg · /help"
		if m.be.CryptoErr != "" {
			s += " · E2EE off: " + m.be.CryptoErr
		}
	}
	return fit(dim.Render(s), w)
}

func (m *model) jumpLines(w, h int) []string {
	out := []string{accent.Render("  Jump to channel: ") + m.jumpIn.View(), ""}
	for i, c := range m.jumpMatches() {
		if len(out) >= h {
			break
		}
		l := "  " + c.label
		if i == m.jumpSel {
			l = selStyle.Render(fit(l, w-2))
		}
		out = append(out, l)
	}
	return out
}
