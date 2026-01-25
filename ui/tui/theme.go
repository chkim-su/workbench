package main

import "github.com/charmbracelet/lipgloss"

type theme struct {
	Header     lipgloss.Style
	Frame      lipgloss.Style
	Panel      lipgloss.Style
	Divider    lipgloss.Style
	Muted      lipgloss.Style
	Accent     lipgloss.Style
	Success    lipgloss.Style
	Alert      lipgloss.Style
	Danger     lipgloss.Style
	Input      lipgloss.Style
	Overlay    lipgloss.Style
	OverlayBox lipgloss.Style
}

func defaultTheme() theme {
	accent := lipgloss.Color("#00FFFF")
	secondary := lipgloss.Color("#7D7D7D")
	success := lipgloss.Color("#00FF00")
	alert := lipgloss.Color("#FFBF00")
	danger := lipgloss.Color("#FF0055")

	return theme{
		Header: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent),
		Frame: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(accent).
			Padding(0, 1),
		Panel: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(secondary).
			Padding(0, 1),
		Divider: lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			BorderForeground(secondary),
		Muted: lipgloss.NewStyle().
			Foreground(secondary),
		Accent: lipgloss.NewStyle().
			Foreground(accent),
		Success: lipgloss.NewStyle().
			Foreground(success),
		Alert: lipgloss.NewStyle().
			Foreground(alert),
		Danger: lipgloss.NewStyle().
			Foreground(danger),
		Input: lipgloss.NewStyle().
			Foreground(accent),
		Overlay: lipgloss.NewStyle().
			Foreground(secondary),
		OverlayBox: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(accent).
			Padding(0, 1),
	}
}

