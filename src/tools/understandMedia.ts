import { z } from 'zod';
import axios from 'axios'; // Default import
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { GEMINI_API_KEY, GEMINI_API_URL, GEMINI_UNDERSTANDING_MODEL, REQUEST_TIMEOUT, DEFAULT_OUTPUT_DIR } from '../config.js';
import { generateUniqueFilename, deleteFile, downloadFile } from '../utils/fileUtils.js';

// --- Helper function to delay execution ---
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Polling Configuration ---
const FILE_POLLING_INTERVAL_MS = 5000; // Check every 5 seconds
const MAX_FILE_POLLING_ATTEMPTS = 36; // Max attempts (e.g., 36 * 5s = 3 minutes timeout)

// Schema for a single file source (URL or Path)
const fileSourceSchema = z.object({
    url: z.string().url().optional().describe("URL of the file (image, video, audio, pdf, text, code)."),
    path: z.string().optional().describe("Local path to the file (image, video, audio, pdf, text, code)."),
    // Added file_uri as an alternative input
    file_uri: z.string().regex(/^files\/[a-zA-Z0-9]+$/, "file_uri must be in the format 'files/xxxxxx'").optional()
        .describe("Optional. Pre-uploaded file URI (e.g., 'files/xxxxxx'). If provided, 'url' and 'path' for this file object will be ignored."),
    // Added mime_type, required only if file_uri is provided
    mime_type: z.string().optional()
        .describe("Required only if 'file_uri' is provided. The MIME type of the pre-uploaded file (e.g., 'video/mp4', 'application/pdf')."),
}).refine(data => {
    const sources = [data.url, data.path, data.file_uri].filter(Boolean).length;
    if (sources !== 1) return false; // Exactly one source must be provided
    if (data.file_uri && !data.mime_type) return false; // mime_type is required if file_uri is used
    return true;
}, {
    message: "For each file, provide exactly one of 'url', 'path', or 'file_uri'. If 'file_uri' is provided, 'mime_type' is also required.",
});


// Define the base object schema first, accepting an array of files
const understandMediaBaseSchema = z.object({
    text: z.string().min(1).describe("Required. The specific question or instruction for the AI model about the content of the provided file(s). E.g., 'Summarize this document', 'Describe this image', 'Transcribe this audio'. This field must contain the textual prompt."),
    // Updated description for 'files'
    files: z.array(fileSourceSchema).min(1).describe("Required. An array containing one or more file objects. Each object *must* specify either a 'url', 'path', or ('file_uri' and 'mime_type') key pointing to a supported file. Example: [{path: '/path/to/report.pdf'}, {url: '...'}, {file_uri: 'files/abcde', mime_type: 'image/png'}]"),
});

// Refined schema (though base shape is used for registration)
export const understandMediaSchema = understandMediaBaseSchema; // No top-level refine needed now

// Export the base shape specifically for tool registration
export const understandMediaShape = understandMediaBaseSchema.shape;

// Type definition for the validated parameters
type UnderstandMediaParams = z.infer<typeof understandMediaSchema>;

// --- Google File API Response Interfaces ---
interface FileInfo {
    name: string;
    uri: string;
    mimeType: string;
    createTime: string;
    updateTime: string;
    displayName: string;
    sizeBytes: string;
    state?: 'PROCESSING' | 'ACTIVE' | 'FAILED' | 'STATE_UNSPECIFIED';
    videoMetadata?: {
        videoDuration: { seconds: number; nanos: number };
    };
}
interface FileApiResponse {
    file: FileInfo;
}
interface GetFileApiResponse extends FileInfo {}

// --- Gemini Generate Content Response Interface ---
interface GeminiContentResponse {
    candidates?: Array<{
        content: {
            parts: Array<{ text: string }>;
            role: string;
        };
    }>;
    error?: {
        code: number;
        message: string;
        status: string;
    };
}

// Interface to store processed file info (including name for polling)
interface ProcessedFileInfo {
    name?: string; // Name might not be available if using pre-uploaded URI directly
    uri: string;
    mimeType: string;
    originalSource: string; // URL, path, or file_uri for logging/errors
}

// Set of supported MIME types based on user feedback and Gemini docs
const SUPPORTED_MIME_TYPES = new Set([
    // Video
    'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
    'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
    // Audio
    'audio/wav', 'audio/mp3', 'audio/mpeg',
    'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
    // Image
    'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
    // Document/Text/Code
    'application/pdf',
    'application/x-javascript', 'text/javascript',
    'application/x-python', 'text/x-python',
    'text/plain',
    'text/html',
    'text/css',
    'text/markdown',
    'text/csv',
    'text/xml', 'application/xml',
    'text/rtf', 'application/rtf'
]);


/**
 * Uploads a file to the Google File API using the global axios instance.
 * Returns the file name and URI upon successful upload.
 */
async function uploadFileToGoogleApi(filePath: string, mimeType: string, displayName: string): Promise<{ name: string, uri: string }> {
    console.log(`[uploadFileToGoogleApi] Starting upload for: ${filePath}, MIME: ${mimeType}`);
    const stats = await fs.stat(filePath);
    const numBytes = stats.size;

    if (numBytes === 0) {
        throw new Error(`File is empty and cannot be uploaded: ${filePath}`);
    }

    const startUploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`;

    // 1. Start Resumable Upload
    console.log('[uploadFileToGoogleApi] Initiating resumable upload...');
    let uploadUrl = '';
    try {
        const startResponse = await axios.post(startUploadUrl,
            { file: { display_name: displayName } },
            {
                headers: {
                    'X-Goog-Upload-Protocol': 'resumable',
                    'X-Goog-Upload-Command': 'start',
                    'X-Goog-Upload-Header-Content-Length': numBytes.toString(),
                    'X-Goog-Upload-Header-Content-Type': mimeType,
                    'Content-Type': 'application/json',
                },
                timeout: REQUEST_TIMEOUT,
            }
        );
        uploadUrl = startResponse.headers?.['x-goog-upload-url'] ?? '';
        if (!uploadUrl) {
            console.error('[uploadFileToGoogleApi] Failed to get upload URL from headers:', startResponse.headers);
            throw new Error('Failed to initiate resumable upload: No upload URL received.');
        }
        console.log('[uploadFileToGoogleApi] Got upload URL.');
    } catch (error: unknown) {
        const err = error as any;
        let message = 'Failed to initiate resumable upload.';
        if (err.response && err.message) {
            message += ` Axios Error: ${err.message} - ${JSON.stringify(err.response?.data)}`;
            console.error('[uploadFileToGoogleApi] Axios error initiating resumable upload:', err.response?.data || err.message);
        } else if (err.message) {
             message += ` Error: ${err.message}`;
            console.error('[uploadFileToGoogleApi] Error initiating resumable upload:', err.message);
        } else {
            console.error('[uploadFileToGoogleApi] Unknown error initiating resumable upload:', error);
        }
        throw new Error(message);
    }

    // 2. Upload File Data
    console.log('[uploadFileToGoogleApi] Uploading file data...');
    try {
        const fileData = await fs.readFile(filePath);
        const uploadConfig = {
            headers: {
                'Content-Length': numBytes.toString(),
                'X-Goog-Upload-Offset': '0',
                'X-Goog-Upload-Command': 'upload, finalize',
                'Content-Type': mimeType,
            },
             maxBodyLength: Infinity,
             maxContentLength: Infinity,
             timeout: REQUEST_TIMEOUT * 5,
        };
        const uploadResponse = await axios.post<FileApiResponse>(uploadUrl, fileData, uploadConfig);

        if (uploadResponse.status !== 200 || !uploadResponse.data?.file?.uri || !uploadResponse.data?.file?.name) {
            console.error('[uploadFileToGoogleApi] File upload failed or URI/Name missing:', uploadResponse.data);
            throw new Error(`File upload failed with status ${uploadResponse.status}. Response: ${JSON.stringify(uploadResponse.data)}`);
        }

        const { name, uri } = uploadResponse.data.file;
        console.log(`[uploadFileToGoogleApi] File uploaded successfully. Name: ${name}, URI: ${uri}`);
        return { name, uri };

    } catch (error: unknown) {
         const err = error as any;
         let message = 'Failed to upload file data.';
         if (err.response && err.message) {
             message += ` Axios Error: ${err.message} - ${JSON.stringify(err.response?.data)}`;
            console.error('[uploadFileToGoogleApi] Axios error uploading file data:', err.response?.data || err.message);
        } else if (err.message) {
             message += ` Error: ${err.message}`;
            console.error('[uploadFileToGoogleApi] Error uploading file data:', err.message);
        } else {
            console.error('[uploadFileToGoogleApi] Unknown error uploading file data:', error);
        }
        throw new Error(message);
    }
}

/**
 * Polls the Google File API for the status of a file until it's ACTIVE or failed/timed out.
 */
async function pollFileStatus(fileName: string): Promise<void> {
    console.log(`[pollFileStatus] Starting polling for file: ${fileName}`);
    const getFileUrl = `${GEMINI_API_URL}/v1beta/${fileName}?key=${GEMINI_API_KEY}`;
    let attempts = 0;

    while (attempts < MAX_FILE_POLLING_ATTEMPTS) {
        attempts++;
        console.log(`[pollFileStatus] Polling status for ${fileName} (Attempt ${attempts}/${MAX_FILE_POLLING_ATTEMPTS})...`);

        try {
            const response = await axios.get<GetFileApiResponse>(getFileUrl, { timeout: REQUEST_TIMEOUT });
            const fileState = response.data?.state;

            console.log(`[pollFileStatus] File ${fileName} state: ${fileState}`);

            if (fileState === 'ACTIVE') {
                console.log(`[pollFileStatus] File ${fileName} is ACTIVE.`);
                return;
            } else if (fileState === 'FAILED') {
                console.error(`[pollFileStatus] File ${fileName} processing failed. Response:`, response.data);
                throw new Error(`Processing failed for file ${fileName}.`);
            }

        } catch (pollError: unknown) {
             const err = pollError as any;
             console.error(`[pollFileStatus] Error polling status for ${fileName}:`, err.response?.data || err.message || pollError);
        }

        if (attempts >= MAX_FILE_POLLING_ATTEMPTS) {
            console.error(`[pollFileStatus] Polling timed out for file ${fileName} after ${MAX_FILE_POLLING_ATTEMPTS} attempts.`);
            throw new Error(`Polling timed out for file ${fileName}. It did not become ACTIVE.`);
        }

        await delay(FILE_POLLING_INTERVAL_MS);
    }
}


/**
 * Handles the media understanding tool request for multiple files.
 */
export async function handleUnderstandMedia(
    params: UnderstandMediaParams,
    axiosInstance: any
): Promise<{ content: Array<TextContent> }> {
    const { text, files } = params;
    const tempSubDir = 'tmp';

    const processedFiles: ProcessedFileInfo[] = [];
    const cleanupPaths: string[] = [];
    const filesToPoll: string[] = [];

    try {
        console.log(`[understandMedia] Received request with text: "${text}" and ${files.length} file(s).`);

        // --- 1. Process each file input ---
        const processingPromises = files.map(async (fileSource) => {
            const originalSource = fileSource.url || fileSource.path || fileSource.file_uri || 'unknown';
            let fileUri: string | undefined = fileSource.file_uri;
            let mimeType: string | undefined = fileSource.mime_type;
            let fileName: string | undefined;

            if (fileUri && mimeType) {
                console.log(`[understandMedia] Using pre-uploaded file URI: ${fileUri} with MIME type: ${mimeType}`);
                // Assume pre-uploaded files are ACTIVE or let Gemini handle the state check. No polling needed here.
            }
            else if (fileSource.url || fileSource.path) {
                let localFilePath: string | null = null;
                let isTemp = false;

                if (fileSource.url) {
                    console.log(`[understandMedia] Downloading media from URL: ${fileSource.url}`);
                    localFilePath = await downloadFile(fileSource.url, DEFAULT_OUTPUT_DIR, tempSubDir, 'downloaded_media');
                    isTemp = true;
                    cleanupPaths.push(localFilePath);
                    console.log(`[understandMedia] Media downloaded to: ${localFilePath}`);
                } else if (fileSource.path) {
                    await fs.access(fileSource.path);
                    localFilePath = path.resolve(fileSource.path);
                    console.log(`[understandMedia] Using local file: ${localFilePath}`);
                }

                if (!localFilePath) throw new Error(`Invalid file source object: ${JSON.stringify(fileSource)}`);

                // Handle potential 'false' return from mime.lookup
                const lookupResult = mime.lookup(localFilePath);
                mimeType = lookupResult === false ? undefined : lookupResult; // Assign undefined if false

                if (!mimeType) {
                    if (isTemp) await deleteFile(localFilePath).catch(e => console.error(`[understandMedia] Error cleaning up temp file ${localFilePath} after MIME type failure:`, e));
                    throw new Error(`Could not determine MIME type for file: ${localFilePath}`);
                }

                const fileExt = path.extname(localFilePath).toLowerCase();
                if (fileExt === '.mp3' && mimeType === 'audio/mpeg') {
                    console.log(`[understandMedia] Correcting MIME type for .mp3 file from 'audio/mpeg' to 'audio/mp3'.`);
                    mimeType = 'audio/mp3';
                }

                // Upload the file
                const displayName = path.basename(localFilePath);
                const uploadResult = await uploadFileToGoogleApi(localFilePath, mimeType, displayName);
                fileUri = uploadResult.uri;
                fileName = uploadResult.name;
                filesToPoll.push(fileName);
            } else {
                 throw new Error(`Invalid file source object, missing url, path, or file_uri/mime_type: ${JSON.stringify(fileSource)}`);
            }

            // Validate MIME type *after* potential correction and before adding
            if (!mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) {
                 throw new Error(`Unsupported file type '${mimeType || 'unknown'}' for source: ${originalSource}.`);
            }
            console.log(`[understandMedia] Validated MIME type: ${mimeType} for source: ${originalSource}`);

            if (!fileUri) {
                 throw new Error(`Failed to obtain file URI for source: ${originalSource}`);
            }

            processedFiles.push({ name: fileName, uri: fileUri, mimeType: mimeType, originalSource: originalSource });

        }); // End map

        await Promise.all(processingPromises);


        if (processedFiles.length !== files.length) {
             throw new Error("Some files failed during processing or upload.");
        }
        if (processedFiles.length === 0) {
            throw new Error("No files were successfully processed.");
        }

        // --- 2. Poll for ACTIVE status for newly uploaded files ---
        if (filesToPoll.length > 0) {
            console.log(`[understandMedia] Polling status for ${filesToPoll.length} newly uploaded file(s)...`);
            const pollingPromises = filesToPoll.map(name => pollFileStatus(name));
            await Promise.all(pollingPromises);
            console.log(`[understandMedia] All newly uploaded files are ACTIVE.`);
        } else {
             console.log(`[understandMedia] No new files were uploaded, skipping polling.`);
        }


        // --- 3. Call Gemini Generate Content ---
        const generateContentUrl = `/v1beta/models/${GEMINI_UNDERSTANDING_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const requestParts = [
            { text: text },
            ...processedFiles.map(fileInfo => ({
                file_data: { mime_type: fileInfo.mimeType, file_uri: fileInfo.uri }
            }))
        ];
        const requestPayload = { contents: [{ parts: requestParts }] };

        console.log(`[understandMedia] Calling Gemini (${GEMINI_UNDERSTANDING_MODEL}) with ${processedFiles.length} file(s)... URL: ${axiosInstance.defaults.baseURL}${generateContentUrl}`);
        const response = await axiosInstance.post(generateContentUrl, requestPayload, { timeout: REQUEST_TIMEOUT });

        // --- 4. Process Response ---
        const responseData = response.data as GeminiContentResponse;
        if (responseData.error) {
             console.error(`[understandMedia] Gemini API returned an error:`, responseData.error);
             throw new Error(`Gemini API error: ${responseData.error.message} (Status: ${responseData.error.status})`);
        }
        const generatedText = responseData.candidates?.[0]?.content?.parts?.map((part: { text: string }) => part.text).join('\n') || '';

        if (!generatedText && !responseData.candidates) {
             console.error('[understandMedia] Gemini response is missing candidates or text parts:', responseData);
             throw new Error('Invalid response structure from Gemini API.');
        } else if (!generatedText) {
             console.warn('[understandMedia] Gemini response did not contain text parts, but candidates exist.', responseData);
             return { content: [{ type: 'text', text: '(Model returned empty text content)' }] };
        }

        console.log('[understandMedia] Tool execution successful.');
        return { content: [{ type: 'text', text: generatedText }] };

    } catch (error: unknown) {
        console.error('[understandMedia] Error during media understanding:', error);
        let errorMessage = 'An unknown error occurred during media understanding.';
        const err = error as any;
        if (err.response && err.message) {
             const responseInfo = err.response ? ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}` : 'No response data.';
             errorMessage = `API request failed: ${err.message}.${responseInfo}`;
        } else if (error instanceof Error) {
             errorMessage = error.message;
        } else if (err.message) {
            errorMessage = err.message;
        } else {
             errorMessage = `Caught non-standard error: ${String(error)}`;
        }
        return { content: [{ type: 'text', text: `Error understanding media: ${errorMessage}` }] };
    } finally {
        // --- 5. Cleanup Downloaded Files ---
        if (cleanupPaths.length > 0) {
            console.log(`[understandMedia] Cleaning up ${cleanupPaths.length} downloaded temporary file(s)...`);
            const results = await Promise.allSettled(cleanupPaths.map(tempPath => deleteFile(tempPath)));
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.error(`[understandMedia] Failed to clean up downloaded file ${cleanupPaths[index]}:`, result.reason);
                }
            });
        }
    }
}
