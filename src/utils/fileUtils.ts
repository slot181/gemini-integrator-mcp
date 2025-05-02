import * as fs from 'fs/promises';
import * as fsSync from 'fs'; // Import sync fs for createWriteStream
import * as path from 'path';
import axios from 'axios'; // Need axios for downloading
import { Stream } from 'stream'; // For stream typing
import * as crypto from 'crypto'; // For temp filenames
import { REQUEST_TIMEOUT } from '../config.js'; // Import timeout
import * as mime from 'mime-types'; // Import mime-types for fallback lookup

/**
 * Saves data (typically base64 decoded image/video) to a file.
 * Ensures the directory exists before writing.
 *
 * @param outputDir The base directory for saving files (e.g., './output').
 * @param subfolder The subfolder within the output directory (e.g., 'image', 'video', 'tmp').
 * @param filename The desired filename (e.g., 'generated_image.png').
 * @param data The data buffer to write.
 * @returns The full path to the saved file.
 */
export async function saveFile(outputDir: string, subfolder: string, filename: string, data: Buffer): Promise<string> {
    const fullDirPath = path.resolve(outputDir, subfolder); // Use path.resolve for absolute path
    const fullFilePath = path.join(fullDirPath, filename);

    try {
        // Ensure the directory exists, creating it recursively if necessary
        await fs.mkdir(fullDirPath, { recursive: true });

        // Write the file
        await fs.writeFile(fullFilePath, data);

        console.log(`[fileUtils] File saved successfully to: ${fullFilePath}`);
        return fullFilePath;
    } catch (error) {
        console.error(`[fileUtils] Error saving file to ${fullFilePath}:`, error);
        throw new Error(`Failed to save file: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Generates a unique filename, typically using a timestamp and a random suffix.
 * @param prefix A prefix for the filename (e.g., 'image', 'video', 'edit').
 * @param extension The file extension including the dot (e.g., '.png', '.mp4').
 * @returns A unique filename string.
 */
export function generateUniqueFilename(prefix: string, extension: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    // Ensure extension starts with a dot
    const finalExtension = extension.startsWith('.') ? extension : `.${extension}`;
    return `${prefix}-${timestamp}-${randomSuffix}${finalExtension}`;
}

/**
 * Deletes a file.
 * @param filePath The path to the file to delete.
 */
export async function deleteFile(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
        console.log(`[fileUtils] Deleted file: ${filePath}`);
    } catch (error: any) {
        // Ignore error if file doesn't exist (it might have been cleaned up already)
        if (error.code !== 'ENOENT') {
            console.error(`[fileUtils] Error deleting file ${filePath}:`, error);
        } else {
            console.log(`[fileUtils] File not found for deletion (already deleted?): ${filePath}`);
        }
    }
}

// Helper function to check if an object is an async iterable
function isAsyncIterable(obj: any): obj is AsyncIterable<any> {
  return obj != null && typeof obj[Symbol.asyncIterator] === 'function';
}


/**
 * Downloads a file from a URL to a specified directory.
 * Generates a unique filename based on prefix and detected/fallback extension.
 * Prioritizes Content-Type header, then URL path extension.
 *
 * @param url The URL of the file to download.
 * @param outputDir The base directory to save the downloaded file.
 * @param subfolder The subfolder within the output directory.
 * @param filenamePrefix Prefix for the generated unique filename.
 * @returns The full path to the downloaded file.
 * @throws If download fails or the response is not a success status.
 */
export async function downloadFile(url: string, outputDir: string, subfolder: string, filenamePrefix: string): Promise<string> {
    const fullDirPath = path.resolve(outputDir, subfolder);
    await fs.mkdir(fullDirPath, { recursive: true });

    let finalFilePath = ''; // Will be determined after getting headers/URL path
    let response; // Declare response outside try block to access in catch

    try {
        console.log(`[fileUtils] Downloading file from URL: ${url}`);
        response = await axios({ // Assign to outer scope variable
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: REQUEST_TIMEOUT * 2, // Allow longer timeout for downloads
        });

        if (response.status < 200 || response.status >= 300) {
            // Attempt to read error message from stream if possible
            let errorBody = '';
            // Check if response.data is an async iterable before trying to read it
            if (isAsyncIterable(response.data)) {
                try {
                    for await (const chunk of response.data) {
                        // Ensure chunk is converted to string appropriately
                        errorBody += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
                    }
                } catch (streamError) {
                    console.warn('[fileUtils] Error reading error response stream:', streamError);
                }
            } else {
                 errorBody = '(Could not read response body)';
            }
            throw new Error(`Download failed with status code ${response.status}. Response: ${errorBody}`);
        }

        let extension = '.tmp'; // Default extension
        const contentType = response.headers['content-type'];
        let contentTypeValid = false;

        // 1. Try Content-Type Header
        if (contentType) {
            const mainType = contentType.split(';')[0].trim();
            const guessedExtension = mime.extension(mainType);
            if (guessedExtension) {
                if (!mainType.startsWith('application/') || mainType === 'application/pdf') {
                     extension = `.${guessedExtension}`;
                     contentTypeValid = true;
                     console.log(`[fileUtils] Determined extension '${extension}' from Content-Type: ${contentType}`);
                } else {
                    console.warn(`[fileUtils] Content-Type '${contentType}' seems invalid for media, ignoring for extension.`);
                }
            } else {
                 console.warn(`[fileUtils] Could not determine extension from Content-Type: ${contentType}`);
            }
        } else {
             console.warn(`[fileUtils] Content-Type header missing in download response.`);
        }

        // 2. Try URL Path Extension (if Content-Type was invalid or missing)
        if (!contentTypeValid) {
            try {
                const parsedUrl = new URL(url);
                const pathExtension = path.extname(parsedUrl.pathname).toLowerCase();
                if (pathExtension && pathExtension.length > 1) {
                    extension = pathExtension;
                    console.log(`[fileUtils] Determined extension '${extension}' from URL path.`);
                } else {
                     console.warn(`[fileUtils] No valid extension found in URL path: ${parsedUrl.pathname}. Falling back to '${extension}'.`);
                }
            } catch (urlParseError) {
                 console.warn(`[fileUtils] Could not parse URL to extract path extension. Falling back to '${extension}'.`);
            }
        }


        // Generate unique name with determined extension
        finalFilePath = generateUniqueFilename(filenamePrefix, extension);
        finalFilePath = path.join(fullDirPath, path.basename(finalFilePath));


        const writer = fsSync.createWriteStream(finalFilePath);
        const stream = response.data as Stream;
        stream.pipe(writer);

        await new Promise<void>((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', (err) => {
                console.error(`[fileUtils] Write stream error for ${finalFilePath}:`, err);
                reject(new Error(`Failed to write downloaded file: ${err.message}`));
            });
            stream.on('error', (err) => {
                console.error(`[fileUtils] Download stream error from ${url}:`, err);
                reject(new Error(`Failed to download file stream: ${err.message}`));
            });
        });

        console.log(`[fileUtils] File downloaded successfully to: ${finalFilePath}`);
        return finalFilePath;

    } catch (error: unknown) {
        console.error(`[fileUtils] Failed to download file from ${url}:`, error);
        // Attempt cleanup if file was partially created
        if (finalFilePath) {
            await deleteFile(finalFilePath).catch(e => console.error(`[fileUtils] Error cleaning up file ${finalFilePath} after download error:`, e));
        }
        // Rethrow a more specific error
        const err = error as any;
        let errorMessage = `Download failed due to an unknown error.`;
        // Check if it's the specific error we threw earlier with status code
        if (error instanceof Error && error.message.startsWith('Download failed with status code')) {
             errorMessage = error.message; // Use the message we constructed
        } else if (err.response && err.message) { // Check for Axios-like errors
             errorMessage = `Download failed: ${err.message} (Status: ${err.response?.status})`;
        } else if (error instanceof Error) { // Catch other standard Error instances
             errorMessage = `Download failed: ${error.message}`;
        } else if (err.message) { // Fallback for other error-like objects
             errorMessage = `Download failed: ${err.message}`;
        }
        throw new Error(errorMessage);
    }
}
