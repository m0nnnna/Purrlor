// purrlor-tui: a small terminal client for Purrlor (Matrix Spaces as servers).
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// version is set at release builds: -ldflags "-X main.version=1.0.0" (from the tui-v* tag).
var version = "dev"

func ctxTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

func main() {
	var opts options
	showVersion := flag.Bool("version", false, "print the version and exit")
	logout := flag.Bool("logout", false, "clear the saved session and crypto database, then exit")
	flag.BoolVar(&opts.compact, "compact", false, "IRC-style one-line message rendering")
	flag.BoolVar(&opts.noBell, "no-bell", false, "don't ring the terminal bell on mentions")
	flag.Usage = func() {
		fmt.Fprint(os.Stderr, "purrlor-tui — a tiny terminal client for Purrlor\n\nUsage: purrlor-tui [flags]\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *showVersion {
		fmt.Println("purrlor-tui", version)
		return
	}

	if *logout {
		if s := loadSession(); s != nil {
			if be, err := newBackend(s); err == nil {
				be.Logout()
				be.Stop()
			}
		}
		clearSession()
		fmt.Println("logged out, session cleared")
		return
	}

	lipgloss.SetHasDarkBackground(true) // skip the slow terminal background query
	m := newModel(opts, loadSession())
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	m.prog = p
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
