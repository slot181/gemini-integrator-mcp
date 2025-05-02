import * as fs from 'fs/promises';
import * as fsSync from 'fs'; // Import sync fs for createWriteStream
import * as path from 'path';
import axios from 'axios'; // Need axios for downloading
import { Stream } from 'stream'; // For stream typing
import * as crypto from 'crypto'; // For temp filenames
import { REQUEST_TIMEOUT } from '../config.js'; // Import timeout

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
            // Decide if you want to throw or just log the error
            // throw new Error(`Failed to delete file: ${error.message}`);
        } else {
            console.log(`[fileUtils] File not found for deletion (already deleted?): ${filePath}`);
        }
    }
}

/**
 * Downloads a file from a URL to a specified directory.
 * Generates a unique filename based on prefix and detected/fallback extension.
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

    let tempFilePath = path.join(fullDirPath, `${filenamePrefix}-${crypto.randomBytes(8).toString('hex')}`); // Temp name without extension
    let finalFilePath = ''; // Will be determined after getting headers

    try {
        console.log(`[fileUtils] Downloading file from URL: ${url}`);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: REQUEST_TIMEOUT * 2, // Allow longer timeout for downloads
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Download failed with status code ${response.status}`);
        }

        const contentType = response.headers['content-type'];
        let extension = '.tmp'; // Default extension
        if (contentType) {
            // Basic extension detection from mime type
            if (contentType.startsWith('image/png')) extension = '.png';
            else if (contentType.startsWith('image/jpeg')) extension = '.jpg';
            else if (contentType.startsWith('image/gif')) extension = '.gif';
            else if (contentType.startsWith('image/webp')) extension = '.webp';
            else if (contentType.startsWith('video/mp4')) extension = '.mp4';
            else if (contentType.startsWith('video/webm')) extension = '.webm';
            else if (contentType.startsWith('audio/mpeg')) extension = '.mp3';
            else if (contentType.startsWith('audio/ogg')) extension = '.ogg';
            else if (contentType.startsWith('audio/wav')) extension = '.wav';
            // Add more types as needed
            else {
                const mimeParts = contentType.split('/');
                if (mimeParts.length === 2) {
                    extension = `.${mimeParts[1].split(';')[0]}`; // Get subtype, remove parameters like charset
                }
            }
        }

        // Generate unique name with determined extension
        finalFilePath = generateUniqueFilename(filenamePrefix, extension);
        finalFilePath = path.join(fullDirPath, path.basename(finalFilePath)); // Ensure it's in the correct directory


        const writer = fsSync.createWriteStream(finalFilePath); // Use fsSync for createWriteStream
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
        } else if (tempFilePath) {
             // If final path wasn't determined, try cleaning up the initial temp path
             await deleteFile(tempFilePath + '.tmp').catch(e => {}); // Try cleaning up potential fallback
        }
        // Revert to less type-safe error checking
        const err = error as any;
        let errorMessage = `Download failed due to an unknown error.`;
        if (err.response && err.message) {
             errorMessage = `Download failed: ${err.message} (Status: ${err.response?.status})`;
        } else if (err.message) {
             errorMessage = `Download failed: ${err.message}`;
        }
        throw new Error(errorMessage);
    }
}
