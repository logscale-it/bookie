//! AI receipt extraction: builds one provider request for an uploaded
//! receipt (PDF or image) and pulls the model's text out of the response.
//! Pure; `ai_extract_invoice` in lib.rs does the keyring read and HTTP.
//!
//! Three request shapes cover all providers: Anthropic Messages, Gemini
//! generateContent, and OpenAI-compatible chat completions (`openai` covers
//! any compatible API via its base URL: OpenAI, Z.AI, OpenRouter, …; plus
//! Mistral and Ollama via its `/v1` endpoint).

use base64::Engine;
use serde_json::{json, Value};

pub const PROMPT: &str = "Lies diese Eingangsrechnung aus. Antworte ausschließlich mit einem \
JSON-Objekt ohne weiteren Text: {\"supplier_name\": string, \"invoice_number\": string, \
\"invoice_date\": \"YYYY-MM-DD\", \"net_amount\": number, \"tax_amount\": number, \
\"currency\": string}. net_amount ist die Nettosumme, tax_amount die gesamte Umsatzsteuer. \
Unbekannte Felder auf null setzen.";

/// Returned when an OpenAI-compatible provider other than api.openai.com gets a PDF.
pub const PDF_UNSUPPORTED: &str =
    "Dieser Anbieter kann keine PDFs lesen. Bitte den Beleg als Bild (PNG/JPG) hochladen.";

pub struct AiRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

fn trim_base(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

pub fn build_request(
    provider: &str,
    model: &str,
    base_url: &str,
    mime: &str,
    bytes: &[u8],
    key: Option<&str>,
) -> Result<AiRequest, String> {
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let is_pdf = mime == "application/pdf";
    let key = key.unwrap_or_default().to_string();
    match provider {
        "anthropic" => {
            let kind = if is_pdf { "document" } else { "image" };
            Ok(AiRequest {
                url: "https://api.anthropic.com/v1/messages".into(),
                headers: vec![
                    ("x-api-key", key),
                    ("anthropic-version", "2023-06-01".into()),
                ],
                body: json!({
                    "model": model,
                    "max_tokens": 1024,
                    "messages": [{"role": "user", "content": [
                        {"type": kind, "source": {"type": "base64", "media_type": mime, "data": data}},
                        {"type": "text", "text": PROMPT}
                    ]}]
                }),
            })
        }
        "gemini" => Ok(AiRequest {
            url: format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            ),
            headers: vec![("x-goog-api-key", key)],
            body: json!({
                "contents": [{"parts": [
                    {"inline_data": {"mime_type": mime, "data": data}},
                    {"text": PROMPT}
                ]}]
            }),
        }),
        "openai" | "mistral" | "ollama" => {
            let file_part = if !is_pdf {
                json!({"type": "image_url", "image_url": {"url": format!("data:{mime};base64,{data}")}})
            } else if provider == "openai" && base_url.contains("api.openai.com") {
                json!({"type": "file", "file": {"filename": "beleg.pdf", "file_data": format!("data:{mime};base64,{data}")}})
            } else {
                // ponytail: only OpenAI itself has a confirmed inline-PDF chat input;
                // render page 1 to an image in the frontend if PDFs are needed there.
                return Err(PDF_UNSUPPORTED.into());
            };
            let mut headers = vec![];
            if !key.is_empty() {
                headers.push(("authorization", format!("Bearer {key}")));
            }
            Ok(AiRequest {
                url: format!("{}/chat/completions", trim_base(base_url)),
                headers,
                body: json!({
                    "model": model,
                    "messages": [{"role": "user", "content": [
                        file_part,
                        {"type": "text", "text": PROMPT}
                    ]}]
                }),
            })
        }
        other => Err(format!("Unbekannter KI-Anbieter: {other}")),
    }
}

/// One turn of a Finanzberater conversation. `role` is "user" or "assistant".
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Rejects histories the providers would refuse or that the UI never sends:
/// empty, an unknown role, or not ending on the user's question.
fn validate_chat(messages: &[ChatMessage]) -> Result<(), String> {
    if messages.last().map(|m| m.role.as_str()) != Some("user") {
        return Err("Das Gespräch muss mit einer Frage enden.".into());
    }
    if let Some(m) = messages
        .iter()
        .find(|m| m.role != "user" && m.role != "assistant")
    {
        return Err(format!("Unbekannte Rolle im Gespräch: {}", m.role));
    }
    Ok(())
}

/// Text-only request (Finanzberater): a system prompt plus the conversation so
/// far, same three provider shapes as `build_request`.
pub fn build_text_request(
    provider: &str,
    model: &str,
    base_url: &str,
    system: &str,
    messages: &[ChatMessage],
    key: Option<&str>,
) -> Result<AiRequest, String> {
    validate_chat(messages)?;
    let key = key.unwrap_or_default().to_string();
    let turns = || {
        messages
            .iter()
            .map(|m| json!({"role": m.role, "content": m.content}))
    };
    match provider {
        "anthropic" => Ok(AiRequest {
            url: "https://api.anthropic.com/v1/messages".into(),
            headers: vec![
                ("x-api-key", key),
                ("anthropic-version", "2023-06-01".into()),
            ],
            body: json!({
                "model": model,
                "max_tokens": 2048,
                "system": system,
                "messages": turns().collect::<Vec<_>>()
            }),
        }),
        "gemini" => Ok(AiRequest {
            url: format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            ),
            headers: vec![("x-goog-api-key", key)],
            body: json!({
                "system_instruction": {"parts": [{"text": system}]},
                "contents": messages.iter().map(|m| json!({
                    "role": if m.role == "assistant" { "model" } else { "user" },
                    "parts": [{"text": m.content}]
                })).collect::<Vec<_>>()
            }),
        }),
        "openai" | "mistral" | "ollama" => {
            let mut headers = vec![];
            if !key.is_empty() {
                headers.push(("authorization", format!("Bearer {key}")));
            }
            Ok(AiRequest {
                url: format!("{}/chat/completions", trim_base(base_url)),
                headers,
                body: json!({
                    "model": model,
                    "messages": std::iter::once(json!({"role": "system", "content": system}))
                        .chain(turns())
                        .collect::<Vec<_>>()
                }),
            })
        }
        other => Err(format!("Unbekannter KI-Anbieter: {other}")),
    }
}

/// The model's answer text, or `None` when the response has an unexpected shape.
pub fn response_text(provider: &str, v: &Value) -> Option<String> {
    let text = match provider {
        "anthropic" => v["content"][0]["text"].as_str(),
        "gemini" => v["candidates"][0]["content"]["parts"][0]["text"].as_str(),
        _ => v["choices"][0]["message"]["content"].as_str(),
    };
    text.map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_pdf_uses_document_block() {
        let r = build_request("anthropic", "m", "", "application/pdf", b"x", Some("k")).unwrap();
        assert_eq!(r.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(r.body["messages"][0]["content"][0]["type"], "document");
        assert_eq!(
            r.body["messages"][0]["content"][0]["source"]["data"],
            "eA=="
        );
        assert!(r.headers.contains(&("x-api-key", "k".into())));
    }

    #[test]
    fn gemini_puts_model_in_url() {
        let r = build_request("gemini", "flash", "", "image/png", b"x", Some("k")).unwrap();
        assert!(r.url.ends_with("/models/flash:generateContent"));
        assert_eq!(
            r.body["contents"][0]["parts"][0]["inline_data"]["mime_type"],
            "image/png"
        );
    }

    #[test]
    fn openai_compatible_shapes() {
        let r = build_request(
            "openai",
            "m",
            "https://api.openai.com/v1/",
            "application/pdf",
            b"x",
            Some("k"),
        )
        .unwrap();
        assert_eq!(r.url, "https://api.openai.com/v1/chat/completions");
        assert_eq!(r.body["messages"][0]["content"][0]["type"], "file");
        assert!(r.headers.contains(&("authorization", "Bearer k".into())));

        let r = build_request(
            "ollama",
            "m",
            "http://localhost:11434/v1",
            "image/jpeg",
            b"x",
            None,
        )
        .unwrap();
        assert_eq!(r.body["messages"][0]["content"][0]["type"], "image_url");
        assert!(r.headers.is_empty());

        let zai = build_request(
            "openai",
            "glm-4.5v",
            "https://api.z.ai/api/paas/v4",
            "application/pdf",
            b"x",
            Some("k"),
        );
        assert_eq!(zai.err().as_deref(), Some(PDF_UNSUPPORTED));

        assert_eq!(
            build_request(
                "mistral",
                "m",
                "https://api.mistral.ai/v1",
                "application/pdf",
                b"x",
                Some("k")
            )
            .err()
            .as_deref(),
            Some(PDF_UNSUPPORTED)
        );
        assert!(build_request("nope", "m", "", "image/png", b"x", None).is_err());
    }

    fn chat(turns: &[(&str, &str)]) -> Vec<ChatMessage> {
        turns
            .iter()
            .map(|(role, content)| ChatMessage {
                role: role.to_string(),
                content: content.to_string(),
            })
            .collect()
    }

    #[test]
    fn text_request_shapes() {
        let q = chat(&[("user", "q")]);
        let a = build_text_request("anthropic", "m", "", "sys", &q, Some("k")).unwrap();
        assert_eq!(a.body["system"], "sys");
        assert_eq!(a.body["messages"][0]["content"], "q");

        let g = build_text_request("gemini", "flash", "", "sys", &q, Some("k")).unwrap();
        assert_eq!(g.body["system_instruction"]["parts"][0]["text"], "sys");

        let o = build_text_request("ollama", "m", "http://x/v1/", "sys", &q, None).unwrap();
        assert_eq!(o.url, "http://x/v1/chat/completions");
        assert_eq!(o.body["messages"][0]["role"], "system");
        assert!(o.headers.is_empty());
        assert!(build_text_request("nope", "m", "", "s", &q, None).is_err());
    }

    #[test]
    fn text_request_carries_the_whole_conversation() {
        let c = chat(&[("user", "q1"), ("assistant", "a1"), ("user", "q2")]);

        let a = build_text_request("anthropic", "m", "", "sys", &c, Some("k")).unwrap();
        let roles: Vec<_> = a.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["user", "assistant", "user"]);
        assert_eq!(a.body["messages"][2]["content"], "q2");

        // Gemini calls the assistant "model".
        let g = build_text_request("gemini", "f", "", "sys", &c, Some("k")).unwrap();
        assert_eq!(g.body["contents"][1]["role"], "model");
        assert_eq!(g.body["contents"][1]["parts"][0]["text"], "a1");

        // OpenAI-compatible: system first, then the turns in order.
        let o = build_text_request("openai", "m", "https://x/v1", "sys", &c, Some("k")).unwrap();
        assert_eq!(o.body["messages"].as_array().unwrap().len(), 4);
        assert_eq!(o.body["messages"][3]["content"], "q2");
    }

    #[test]
    fn text_request_rejects_bad_histories() {
        let ok = |c: &[(&str, &str)]| build_text_request("anthropic", "m", "", "s", &chat(c), None);
        assert!(ok(&[]).is_err());
        assert!(ok(&[("user", "q"), ("assistant", "a")]).is_err());
        assert!(ok(&[("system", "x"), ("user", "q")]).is_err());
        assert!(ok(&[("user", "q")]).is_ok());
    }

    #[test]
    fn extracts_text_per_provider() {
        let a = json!({"content": [{"type": "text", "text": "A"}]});
        let g = json!({"candidates": [{"content": {"parts": [{"text": "G"}]}}]});
        let o = json!({"choices": [{"message": {"content": "O"}}]});
        assert_eq!(response_text("anthropic", &a).as_deref(), Some("A"));
        assert_eq!(response_text("gemini", &g).as_deref(), Some("G"));
        assert_eq!(response_text("mistral", &o).as_deref(), Some("O"));
        assert_eq!(response_text("openai", &a), None);
    }
}
