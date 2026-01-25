package main

import (
	"os"
	"strings"
)

func thoughtStreamEnabled() bool {
	v := strings.TrimSpace(os.Getenv("WORKBENCH_TUI_THOUGHT_STREAM"))
	if v == "" {
		v = strings.TrimSpace(os.Getenv("WORKBENCH_OPENCODE_THOUGHT_STREAM"))
	}
	v = strings.ToLower(v)
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func opencodeAgent() string {
	if v := strings.TrimSpace(os.Getenv("WORKBENCH_OPENCODE_AGENT")); v != "" {
		return v
	}
	return "build"
}

func opencodeModelForSelection(providerLabel string, selectedModel string) string {
	if v := strings.TrimSpace(os.Getenv("WORKBENCH_OPENCODE_MODEL")); v != "" {
		return v
	}
	m := strings.TrimSpace(selectedModel)
	if m == "" {
		return ""
	}
	if strings.Contains(m, "/") {
		return m
	}

	p := strings.ToLower(strings.TrimSpace(providerLabel))
	prefix := ""
	switch {
	case strings.Contains(p, "openai"):
		prefix = "openai"
	case strings.Contains(p, "anthropic"):
		prefix = "anthropic"
	case strings.Contains(p, "google"):
		prefix = "google"
	case strings.Contains(p, "gemini"):
		prefix = "google"
	case strings.Contains(p, "ollama"):
		prefix = "ollama"
	}
	if prefix == "" {
		return ""
	}
	return prefix + "/" + m
}
