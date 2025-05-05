import { RAW_UNDERSTAND_MEDIA_SIZE_LIMIT_MB } from '../config.js';

// Hard limit for Gemini inline data (based on known limits, keep fixed unless API changes)
const GEMINI_MAX_INLINE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
// Default limit if user doesn't configure or provides invalid input
const DEFAULT_UNDERSTAND_MEDIA_LIMIT_MB = 20;

/**
 * Calculates the effective user-configured media size limit for inline processing,
 * considering the raw configuration value, default value, and the hard Gemini limit.
 *
 * @param context - A string indicating the calling context (e.g., 'understandMedia', 'uploadLargeMedia', 'index') for logging.
 * @returns An object containing the effective limit in MB and bytes.
 */
export function getEffectiveMediaSizeLimit(context: string): { limitMB: number; limitBytes: number } {
    // Parse and validate the user-configured limit
    const parsedUserLimitMB = parseInt(
        RAW_UNDERSTAND_MEDIA_SIZE_LIMIT_MB || String(DEFAULT_UNDERSTAND_MEDIA_LIMIT_MB), // Use default if raw value is undefined/empty
        10
    );
    const validatedUserLimitMB =
        isNaN(parsedUserLimitMB) || parsedUserLimitMB <= 0
            ? DEFAULT_UNDERSTAND_MEDIA_LIMIT_MB // Default if parsing fails or value is non-positive
            : parsedUserLimitMB;

    // Calculate the effective user limit in bytes, capped by the Gemini hard limit
    const effectiveLimitBytes = Math.min(
        validatedUserLimitMB * 1024 * 1024,
        GEMINI_MAX_INLINE_SIZE_BYTES // Ensure user limit doesn't exceed the hard limit
    );
    const effectiveLimitMB = effectiveLimitBytes / 1024 / 1024; // For user-friendly messages

    // Log the *effective* limit being used by the tool/context
    console.log(`[${context}] Effective size limit threshold being used: ${effectiveLimitMB} MB (${effectiveLimitBytes} bytes)`);

    return {
        limitMB: effectiveLimitMB,
        limitBytes: effectiveLimitBytes,
    };
}

// Also export the hard limit constant if needed elsewhere (though unlikely now)
// export { GEMINI_MAX_INLINE_SIZE_BYTES };
