export const RETRY_EXCLUSION_REASON = {
  alreadyDeliveredOrRead: "already_delivered_or_read",
  duplicateRetryPrevented: "duplicate_retry_prevented",
  retryEligibilityDisabled: "retry_eligibility_disabled",
  cooldownBlocked: "cooldown_blocked",
  missingPhone: "missing_phone",
  policyNonRetryable: "policy_non_retryable",
  permanentFailure: "permanent_failure",
  inFlightTimeout: "in_flight_timeout",
  dlrFailedAfterAccept: "dlr_failed_after_accept",
} as const;

export const RETRY_EXCLUSION_REASONS = Object.values(RETRY_EXCLUSION_REASON);

export type RetryExclusionReason = (typeof RETRY_EXCLUSION_REASONS)[number];

export const MAX_AUTO_ATTEMPTS = 3;
export const RETRY_DELAY_MS_AFTER_ATTEMPT: Record<number, number> = {
  1: 60_000,
  2: 120_000,
};

export const TERMINAL_SUCCESS_STATUSES = ["delivered", "read"] as const;
export const IN_FLIGHT_STATUSES = ["queued", "submitted", "sent"] as const;
export const TERMINAL_FAILURE_STATUSES = ["failed", "retry_exhausted"] as const;

const TRANSIENT_FAILURE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /enotfound/i,
  /network/i,
  /socket/i,
  /5\d\d/,
  /provider.*down/i,
  /service unavailable/i,
  /rate.?limit/i,
  /temporarily/i,
  /try again/i,
];

const INFRASTRUCTURE_SEND_FAILURE_PATTERNS = [
  /WhatsApp disabled/i,
  /ENABLE_WHATSAPP/i,
  /Gupshup not configured/i,
  /template id missing/i,
  /missing.*template/i,
];

const META_PERMANENT_ERROR_CODES = new Set(["131047", "131048", "131049"]);

const PERMANENT_FAILURE_PATTERNS = [
  /invalid/i,
  /not whatsapp/i,
  /no whatsapp/i,
  /whatsapp.*disabled/i,
  /disabled.*whatsapp/i,
  /user.*not.*registered/i,
  /not.*registered.*whatsapp/i,
  /opt.?out/i,
  /blocked/i,
  /blacklist/i,
  /does not exist/i,
  /rejected/i,
  /policy/i,
  /undeliverable/i,
  /unregistered/i,
  /ecosystem engagement/i,
  /healthy ecosystem/i,
  /re-engagement/i,
  /spam rate limit/i,
];

export type FailureContext = {
  errorCode?: string | null;
  errorReason?: string | null;
  errorText?: string | null;
  errorMessage?: string | null;
};

export type FailureClassification = {
  retryable: boolean;
  terminalFailureKind: "permanent" | "transient" | null;
  exclusionReason: RetryExclusionReason | null;
  metaNote: string | null;
};

const haystack = (failCtx: FailureContext) =>
  [failCtx.errorCode, failCtx.errorReason, failCtx.errorText, failCtx.errorMessage]
    .filter(Boolean)
    .join(" | ");

export const isInfrastructureSendFailure = (failCtx: FailureContext = {}) => {
  const hay = haystack(failCtx);
  return hay.length > 0 && INFRASTRUCTURE_SEND_FAILURE_PATTERNS.some((rx) => rx.test(hay));
};

export const isMetaPermanentProviderError = (failCtx: FailureContext = {}) => {
  const code = String(failCtx.errorCode || "").trim();
  if (code && META_PERMANENT_ERROR_CODES.has(code)) return true;
  const hay = haystack(failCtx);
  if (!hay) return false;
  if (/131047|131048|131049/.test(hay)) return true;
  return /ecosystem engagement/i.test(hay) || /healthy ecosystem/i.test(hay);
};

export const getRetryDelayMsAfterAttempt = (fromAttempt: number) => {
  const mapped = RETRY_DELAY_MS_AFTER_ATTEMPT[fromAttempt];
  if (Number.isFinite(mapped)) return mapped;
  return 120_000;
};

export const retrySourceFromAttemptNumber = (
  attemptNumber: number
): "initial" | "retry1" | "retry2" | "manual_recovery" => {
  if (attemptNumber <= 1) return "initial";
  if (attemptNumber === 2) return "retry1";
  if (attemptNumber === 3) return "retry2";
  return "manual_recovery";
};

export const classifyCampaignFailure = (
  failCtx: FailureContext = {},
  opts: { afterProviderAccept?: boolean; attemptNumber?: number } = {}
): FailureClassification => {
  const { afterProviderAccept = false, attemptNumber = 1 } = opts;
  const hay = haystack(failCtx);
  const att = Number(attemptNumber) || 1;
  const hasAttemptsLeft = att < MAX_AUTO_ATTEMPTS;

  if (isInfrastructureSendFailure(failCtx)) {
    return {
      retryable: true,
      terminalFailureKind: null,
      exclusionReason: null,
      metaNote: "infrastructure_not_ready",
    };
  }

  if (isMetaPermanentProviderError(failCtx)) {
    return {
      retryable: false,
      terminalFailureKind: "permanent",
      exclusionReason: RETRY_EXCLUSION_REASON.permanentFailure,
      metaNote: afterProviderAccept ? "webhook_failed_after_provider_accept" : null,
    };
  }

  if (hay && PERMANENT_FAILURE_PATTERNS.some((rx) => rx.test(hay))) {
    return {
      retryable: false,
      terminalFailureKind: "permanent",
      exclusionReason: RETRY_EXCLUSION_REASON.permanentFailure,
      metaNote: afterProviderAccept ? "webhook_failed_after_provider_accept" : null,
    };
  }

  const transient = hay ? TRANSIENT_FAILURE_PATTERNS.some((rx) => rx.test(hay)) : false;

  if (afterProviderAccept) {
    if (transient && hasAttemptsLeft) {
      return {
        retryable: true,
        terminalFailureKind: "transient",
        exclusionReason: null,
        metaNote: "webhook_failed_after_provider_accept_transient",
      };
    }
    return {
      retryable: hasAttemptsLeft && !hay,
      terminalFailureKind: transient ? "transient" : "permanent",
      exclusionReason: hasAttemptsLeft ? null : RETRY_EXCLUSION_REASON.dlrFailedAfterAccept,
      metaNote: "webhook_failed_after_provider_accept",
    };
  }

  if (transient) {
    return {
      retryable: hasAttemptsLeft,
      terminalFailureKind: "transient",
      exclusionReason: hasAttemptsLeft ? null : RETRY_EXCLUSION_REASON.dlrFailedAfterAccept,
      metaNote: null,
    };
  }

  return {
    retryable: hasAttemptsLeft,
    terminalFailureKind: "transient",
    exclusionReason: hasAttemptsLeft ? null : RETRY_EXCLUSION_REASON.dlrFailedAfterAccept,
    metaNote: null,
  };
};
