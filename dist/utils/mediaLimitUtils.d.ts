/**
 * Calculates the effective user-configured media size limit for inline processing,
 * considering the raw configuration value, default value, and the hard Gemini limit.
 *
 * @param context - A string indicating the calling context (e.g., 'understandMedia', 'uploadLargeMedia', 'index') for logging.
 * @returns An object containing the effective limit in MB and bytes.
 */
export declare function getEffectiveMediaSizeLimit(context: string): {
    limitMB: number;
    limitBytes: number;
};
