import { z } from 'zod';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export declare const understandMediaSchema: z.ZodObject<{
    text: z.ZodString;
    files: z.ZodArray<z.ZodEffects<z.ZodObject<{
        url: z.ZodOptional<z.ZodString>;
        path: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        path?: string | undefined;
        url?: string | undefined;
    }, {
        path?: string | undefined;
        url?: string | undefined;
    }>, {
        path?: string | undefined;
        url?: string | undefined;
    }, {
        path?: string | undefined;
        url?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    text: string;
    files: {
        path?: string | undefined;
        url?: string | undefined;
    }[];
}, {
    text: string;
    files: {
        path?: string | undefined;
        url?: string | undefined;
    }[];
}>;
export declare const understandMediaShape: {
    text: z.ZodString;
    files: z.ZodArray<z.ZodEffects<z.ZodObject<{
        url: z.ZodOptional<z.ZodString>;
        path: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        path?: string | undefined;
        url?: string | undefined;
    }, {
        path?: string | undefined;
        url?: string | undefined;
    }>, {
        path?: string | undefined;
        url?: string | undefined;
    }, {
        path?: string | undefined;
        url?: string | undefined;
    }>, "many">;
};
type UnderstandMediaParams = z.infer<typeof understandMediaSchema>;
/**
 * Handles the media understanding tool request for multiple files.
 */
export declare function handleUnderstandMedia(params: UnderstandMediaParams, axiosInstance: any): Promise<{
    content: Array<TextContent>;
}>;
export {};
