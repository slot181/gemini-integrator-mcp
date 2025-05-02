import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'fs/promises'; // Needed to read file for upload
import * as path from 'path';

// Import necessary configuration
import { CF_IMGBED_UPLOAD_URL, CF_IMGBED_API_KEY, REQUEST_TIMEOUT } from '../config.js'; // Add .js extension

/**
 * Uploads a file (image or video) from a local path to Cloudflare ImgBed.
 *
 * @param filePath The local path to the file to upload.
 * @returns The public URL of the uploaded file on CF ImgBed, or null if upload fails or is skipped.
 */
export async function uploadToCfImgbed(filePath: string): Promise<string | null> {
    if (!CF_IMGBED_UPLOAD_URL || !CF_IMGBED_API_KEY) {
        console.warn('[cfUtils] CF ImgBed URL or API Key not configured. Skipping upload.');
        return null;
    }

    const filename = path.basename(filePath);
    let fileData: Buffer;

    try {
        fileData = await fs.readFile(filePath);
    } catch (readError) {
        console.error(`[cfUtils] Error reading file for upload ${filePath}:`, readError);
        return null; // Cannot upload if file cannot be read
    }

    const form = new FormData();
    form.append('file', fileData, filename); // Use the buffer and original filename

    // Construct the upload URL with the API key as 'authCode' query parameter
    const separator = CF_IMGBED_UPLOAD_URL.includes('?') ? '&' : '?';
    const uploadUrlWithAuth = `${CF_IMGBED_UPLOAD_URL}${separator}authCode=${CF_IMGBED_API_KEY}`;

    try {
        console.info(`[cfUtils] Uploading file '${filename}' from '${filePath}' to CF ImgBed...`);
        const response = await axios.post(uploadUrlWithAuth, form, {
            headers: {
                ...form.getHeaders(), // Important for multipart/form-data
            },
            timeout: REQUEST_TIMEOUT, // Use configured timeout
        });

        // Check response based on typical ImgBed success structure
        if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0 && response.data[0]?.src) {
            const imagePathSegment = response.data[0].src;
            // Construct the full URL based on the upload URL's origin
            const parsedUploadUrl = new URL(CF_IMGBED_UPLOAD_URL);
            const baseUrlStr = `${parsedUploadUrl.protocol}//${parsedUploadUrl.host}`;
            const fullUrl = new URL(imagePathSegment, baseUrlStr).toString();
            console.info(`[cfUtils] File uploaded successfully to CF ImgBed: ${fullUrl}`);
            return fullUrl;
        } else {
            console.error(`[cfUtils] Unexpected response format from ImgBed. Status: ${response.status}. Data: ${JSON.stringify(response.data)}`);
            return null;
        }
    } catch (error: unknown) { // Catch as unknown
        let errorMessage = 'Unknown error during ImgBed upload.';
        // Check if it's an object and has expected properties
        if (typeof error === 'object' && error !== null) {
            const err = error as any; // Use 'any' for property checking
            if (err.response && err.message) { // Check for Axios-like properties
                const responseInfo = ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}`;
                errorMessage = `Likely Axios error: ${err.message}.${responseInfo}`;
            } else if (err.message) { // Generic Error object
                errorMessage = `Error: ${err.message}`;
            } else {
                 errorMessage = `Caught non-standard error object: ${JSON.stringify(error)}`;
            }
        } else {
             errorMessage = `Caught non-object error: ${String(error)}`;
        }
        console.error(`[cfUtils] Failed to upload file to ImgBed: ${errorMessage}`);
        return null;
    }
}
