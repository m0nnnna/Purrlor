package main

import (
	"strings"
	"testing"

	"maunium.net/go/mautrix/id"
)

func TestViewHeight(t *testing.T) {
	m := newModel(options{}, &Session{Homeserver: "https://x"})
	m.st = newStore(id.UserID("@a:x"))
	m.be = &Backend{st: m.st}
	m.w, m.h, m.scr = 100, 30, scrChat
	v := m.View()
	if n := len(strings.Split(v, "\n")); n != 30 {
		t.Fatalf("got %d lines", n)
	}
	t.Log("\n" + v)
}
