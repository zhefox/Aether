use std::sync::Arc;

use serde_json::Value;

use crate::ai_serving::transport::gemini_cli::resolve_gemini_cli_project_id;
use crate::ai_serving::transport::{
    build_gemini_cli_v1internal_request, GatewayProviderTransportSnapshot,
    GeminiCliRequestEnvelopeSupport,
};
use crate::AppState;

pub(crate) struct GeminiCliV1InternalPayload {
    pub(crate) transport: Arc<GatewayProviderTransportSnapshot>,
    pub(crate) body: Value,
}

pub(crate) enum GeminiCliV1InternalPayloadError {
    ProjectUnavailable,
    EnvelopeUnsupported,
}

pub(crate) async fn build_gemini_cli_v1internal_payload(
    state: &AppState,
    transport: &Arc<GatewayProviderTransportSnapshot>,
    trace_id: &str,
    mapped_model: &str,
    gemini_request_body: &Value,
) -> Result<GeminiCliV1InternalPayload, GeminiCliV1InternalPayloadError> {
    let mut resolved_transport = Arc::clone(transport);
    let project_id = match resolve_gemini_cli_project_id(&resolved_transport) {
        Some(project_id) => Some(project_id),
        None => match state
            .hydrate_gemini_cli_project_metadata_for_transport(&resolved_transport)
            .await
        {
            Some(hydrated) => {
                let project_id = resolve_gemini_cli_project_id(&hydrated);
                resolved_transport = Arc::new(hydrated);
                project_id
            }
            None => None,
        },
    }
    .ok_or(GeminiCliV1InternalPayloadError::ProjectUnavailable)?;

    let body = match build_gemini_cli_v1internal_request(
        &project_id,
        trace_id,
        mapped_model,
        gemini_request_body,
    ) {
        GeminiCliRequestEnvelopeSupport::Supported(envelope) => envelope,
        GeminiCliRequestEnvelopeSupport::Unsupported(_) => {
            return Err(GeminiCliV1InternalPayloadError::EnvelopeUnsupported);
        }
    };

    Ok(GeminiCliV1InternalPayload {
        transport: resolved_transport,
        body,
    })
}
