package main

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const (
	usageEndpoint = "https://chatgpt.com/backend-api/wham/usage"
	usageCacheTTL = 60 * time.Second
)

type usageWindow struct {
	Type      string  `json:"type"`
	Percent   float64 `json:"percentage"`
	Remaining float64 `json:"remaining"`
	ResetAtMs int64   `json:"resetAtMs"`
}

type usageData struct {
	FetchedAt    int64        `json:"fetchedAt"`
	PlanType     string       `json:"planType"`
	Windows      []usageWindow `json:"windows"`
	Allowed      bool         `json:"allowed"`
	LimitReached bool         `json:"limitReached"`
}

func loadCachedUsage(stateDir string, profile string, now time.Time) (*usageData, bool) {
	p := filepath.Join(stateDir, "cache", "usage", profile+".json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	var u usageData
	if err := json.Unmarshal(raw, &u); err != nil {
		return nil, false
	}
	if u.FetchedAt <= 0 {
		return nil, false
	}
	fetched := time.UnixMilli(u.FetchedAt)
	if now.Sub(fetched) > usageCacheTTL {
		return nil, false
	}
	return &u, true
}

func saveCachedUsage(stateDir string, profile string, u *usageData) {
	if u == nil {
		return
	}
	dir := filepath.Join(stateDir, "cache", "usage")
	_ = os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, profile+".json")
	b, err := json.MarshalIndent(u, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(p, append(b, '\n'), 0o644)
}

func fetchUsage(accessToken string, accountID string) (*usageData, error) {
	if accessToken == "" {
		return nil, errors.New("missing access token")
	}

	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
	}

	req, err := http.NewRequest("GET", usageEndpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "MyLLMWorkbench/1.0")
	if accountID != "" {
		req.Header.Set("ChatGPT-Account-Id", accountID)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, errors.New("non-200 from usage endpoint")
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}

	u := parseUsageResponse(parsed)
	return &u, nil
}

func parseUsageResponse(data map[string]any) usageData {
	u := usageData{
		FetchedAt:    time.Now().UnixMilli(),
		PlanType:     asString(data["plan_type"]),
		Windows:      []usageWindow{},
		Allowed:      true,
		LimitReached: false,
	}

	rl, ok := data["rate_limit"].(map[string]any)
	if ok {
		if allowed, ok := rl["allowed"].(bool); ok {
			u.Allowed = allowed
		}
		if lr, ok := rl["limit_reached"].(bool); ok {
			u.LimitReached = lr
		}
		if pw, ok := rl["primary_window"].(map[string]any); ok {
			used := asFloat(pw["used_percent"])
			resetAt := asInt64(pw["reset_at"])
			u.Windows = append(u.Windows, usageWindow{
				Type:      "5h",
				Percent:   used,
				Remaining: 100 - used,
				ResetAtMs: resetAt * 1000,
			})
		}
		if sw, ok := rl["secondary_window"].(map[string]any); ok {
			used := asFloat(sw["used_percent"])
			resetAt := asInt64(sw["reset_at"])
			u.Windows = append(u.Windows, usageWindow{
				Type:      "weekly",
				Percent:   used,
				Remaining: 100 - used,
				ResetAtMs: resetAt * 1000,
			})
		}
	}

	return u
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func asFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
		return float64(t)
	default:
		return 0
	}
}

func asInt64(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int:
		return int64(t)
	case int64:
		return t
	default:
		return 0
	}
}

