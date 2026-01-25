package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const defaultCodexEndpoint = "https://chatgpt.com/backend-api/codex/responses"

type codexHttpStatusError struct {
	Status       int
	BodySnippet  string
	RetryAfterMs int64
}

func (e *codexHttpStatusError) Error() string {
	if e == nil {
		return "codex error"
	}
	return fmt.Sprintf("codex http %d: %s", e.Status, e.BodySnippet)
}

type codexChatResult struct {
	Text         string
	UsedProfile  string
	SwapFrom     string
	SwapTo       string
	SwapReason   string
	RetryAfterMs int64
}

func codexChatOnce(ctx context.Context, endpoint string, model string, accessToken string, accountID string, instructions string, input []chatMessage) (string, *codexHttpStatusError, error) {
	return codexChatStream(ctx, endpoint, model, accessToken, accountID, instructions, input, nil)
}

func codexChatStream(ctx context.Context, endpoint string, model string, accessToken string, accountID string, instructions string, input []chatMessage, onDelta func(delta string)) (string, *codexHttpStatusError, error) {
	if strings.TrimSpace(accessToken) == "" {
		return "", nil, errors.New("missing OAuth access token")
	}
	if strings.TrimSpace(endpoint) == "" {
		endpoint = defaultCodexEndpoint
	}
	if strings.TrimSpace(model) == "" {
		model = "gpt-5.2-codex"
	}
	if strings.TrimSpace(instructions) == "" {
		instructions = "Workbench session."
	}

	msgs := make([]map[string]any, 0, len(input))
	for _, m := range input {
		role := strings.TrimSpace(m.Role)
		if role == "" {
			continue
		}
		msgs = append(msgs, map[string]any{"role": role, "content": m.Content})
	}

	body := map[string]any{
		"model":        model,
		"instructions": instructions,
		"input":        msgs,
		"store":        false,
		"stream":       true,
	}
	b, err := json.Marshal(body)
	if err != nil {
		return "", nil, err
	}

	client := &http.Client{
		Timeout: 70 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
	}

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(b))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", "MyLLMWorkbench/1.0")
	if strings.TrimSpace(accountID) != "" {
		req.Header.Set("ChatGPT-Account-Id", accountID)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", &codexHttpStatusError{
			Status:       resp.StatusCode,
			BodySnippet:  strings.TrimSpace(string(raw)),
			RetryAfterMs: retryAfterMs(resp),
		}, nil
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var textParts []string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		dataStr := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
		if dataStr == "[DONE]" {
			break
		}
		var event map[string]any
		if json.Unmarshal([]byte(dataStr), &event) != nil {
			continue
		}
		if eventType, _ := event["type"].(string); eventType == "response.output_text.delta" {
			if delta, _ := event["delta"].(string); delta != "" {
				textParts = append(textParts, delta)
				if onDelta != nil {
					onDelta(delta)
				}
			}
		}
		if eventType, _ := event["type"].(string); eventType == "response.completed" {
			if respObj, ok := event["response"].(map[string]any); ok {
				if outText, _ := respObj["output_text"].(string); strings.TrimSpace(outText) != "" {
					return outText, nil, nil
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return "", nil, err
	}
	if len(textParts) == 0 {
		return "", nil, errors.New("empty codex response")
	}
	return strings.Join(textParts, ""), nil, nil
}

func retryAfterMs(resp *http.Response) int64 {
	if resp == nil {
		return 0
	}
	ra := strings.TrimSpace(resp.Header.Get("retry-after"))
	if ra == "" {
		return 0
	}
	if secs, err := strconv.Atoi(ra); err == nil && secs > 0 {
		return int64(secs) * 1000
	}
	if ts, err := http.ParseTime(ra); err == nil {
		ms := ts.Sub(time.Now()).Milliseconds()
		if ms < 0 {
			ms = 0
		}
		return ms
	}
	return 0
}
