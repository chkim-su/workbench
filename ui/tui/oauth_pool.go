package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type oauthPoolProfile struct {
	Profile            string
	Email              string
	Remaining          float64
	ResetAtMs          int64
	RateLimitedUntilMs int64
	Disabled           bool
	Status             string // ACTIVE|STANDBY|LIMITED

	accountID    string
	accessToken  string
}

type oauthPoolSnapshot struct {
	ActiveProfile string
	ActiveEmail   string
	Profiles      []oauthPoolProfile
	Ranked        []oauthPoolProfile
	CodexEndpoint string
	PoolModel     string
}

func readOAuthPoolSnapshot(stateDir string, at time.Time) (oauthPoolSnapshot, bool) {
	path := filepath.Join(stateDir, "auth", "openai_codex_oauth_pool.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return oauthPoolSnapshot{}, false
	}

	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return oauthPoolSnapshot{}, false
	}

	selection, _ := parsed["selection"].(map[string]any)
	lastUsed, _ := selection["lastUsedProfile"].(string)
	profs, _ := parsed["profiles"].(map[string]any)

	atMs := at.UTC().UnixMilli()
	out := oauthPoolSnapshot{
		ActiveProfile: lastUsed,
		ActiveEmail:   "",
		Profiles:      []oauthPoolProfile{},
		Ranked:        []oauthPoolProfile{},
		CodexEndpoint: asString(parsed["codexEndpoint"]),
		PoolModel:     asString(parsed["model"]),
	}

	for k, v := range profs {
		obj, ok := v.(map[string]any)
		if !ok {
			continue
		}
		email, _ := obj["email"].(string)
		accountID, _ := obj["accountId"].(string)
		accessToken, _ := obj["accessToken"].(string)
		if strings.TrimSpace(email) == "" {
			email = extractEmailFromJwt(accessToken)
		}
		disabled, _ := obj["disabled"].(bool)
		remaining := parseFloat(obj["remaining"])
		resetAtMs := parseInt64(obj["resetAtMs"])
		if resetAtMs <= 0 {
			resetAtMs = 1_000_000_000_000_000_000
		}
		rateLimitedUntil := parseInt64(obj["rateLimitedUntilMs"])

		status := "STANDBY"
		if disabled || rateLimitedUntil > atMs {
			status = "LIMITED"
		} else if k == lastUsed {
			status = "ACTIVE"
		}

		p := oauthPoolProfile{
			Profile:            k,
			Email:              nonEmpty(email, k),
			Remaining:          remaining,
			ResetAtMs:          resetAtMs,
			RateLimitedUntilMs: rateLimitedUntil,
			Disabled:           disabled,
			Status:             status,
			accountID:          accountID,
			accessToken:        accessToken,
		}
		out.Profiles = append(out.Profiles, p)
		if k == lastUsed {
			out.ActiveEmail = p.Email
		}
	}

	out.Ranked = rankOAuthCandidates(out.Profiles)
	if out.ActiveProfile == "" {
		// If no ACTIVE recorded, choose deterministically for display.
		for _, c := range out.Ranked {
			if c.Status != "LIMITED" {
				out.ActiveProfile = c.Profile
				out.ActiveEmail = c.Email
				break
			}
		}
	}

	return out, true
}

func setOAuthPoolLastUsedProfile(stateDir string, profile string) error {
	path := filepath.Join(stateDir, "auth", "openai_codex_oauth_pool.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return err
	}
	selection, ok := parsed["selection"].(map[string]any)
	if !ok {
		selection = map[string]any{}
		parsed["selection"] = selection
	}
	selection["lastUsedProfile"] = profile
	selection["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.MarshalIndent(parsed, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}

func setOAuthProfileRateLimitedUntil(stateDir string, profile string, untilMs int64) error {
	path := filepath.Join(stateDir, "auth", "openai_codex_oauth_pool.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return err
	}
	profs, ok := parsed["profiles"].(map[string]any)
	if !ok {
		return nil
	}
	obj, ok := profs[profile].(map[string]any)
	if !ok {
		return nil
	}
	obj["rateLimitedUntilMs"] = untilMs
	obj["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.MarshalIndent(parsed, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}

func rankOAuthCandidates(profiles []oauthPoolProfile) []oauthPoolProfile {
	candidates := make([]oauthPoolProfile, 0, len(profiles))
	for _, p := range profiles {
		if p.Status == "LIMITED" {
			continue
		}
		candidates = append(candidates, p)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		ai := candidates[i]
		aj := candidates[j]
		ri := ai.Remaining
		rj := aj.Remaining
		if ri != rj {
			return ri < rj
		}
		if ai.ResetAtMs != aj.ResetAtMs {
			return ai.ResetAtMs < aj.ResetAtMs
		}
		return ai.Email < aj.Email
	})
	return candidates
}

func parseInt64(v any) int64 {
	switch t := v.(type) {
	case int:
		return int64(t)
	case int64:
		return t
	case float64:
		return int64(t)
	default:
		return 0
	}
}

func parseFloat(v any) float64 {
	switch t := v.(type) {
	case int:
		return float64(t)
	case int64:
		return float64(t)
	case float64:
		return t
	default:
		return 1e18
	}
}

func extractEmailFromJwt(token string) string {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return ""
	}
	payload := parts[1]
	if payload == "" {
		return ""
	}
	if m := len(payload) % 4; m != 0 {
		payload += strings.Repeat("=", 4-m)
	}
	raw, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return ""
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	if nested, ok := claims["https://api.openai.com/profile"].(map[string]any); ok {
		if email, ok := nested["email"].(string); ok {
			return strings.TrimSpace(email)
		}
	}
	if email, ok := claims["email"].(string); ok {
		return strings.TrimSpace(email)
	}
	return ""
}
