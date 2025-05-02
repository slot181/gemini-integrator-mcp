import * as fs from 'fs/promises';
import * as path from 'path';
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
export async function saveFile(outputDir, subfolder, filename, data) {
    const fullDirPath = path.resolve(outputDir, subfolder); // Use path.resolve for absolute path
    const fullFilePath = path.join(fullDirPath, filename);
    try {
        // Ensure the directory exists, creating it recursively if necessary
        await fs.mkdir(fullDirPath, { recursive: true });
        // Write the file
        await fs.writeFile(fullFilePath, data);
        console.log(`[fileUtils] File saved successfully to: ${fullFilePath}`);
        return fullFilePath;
    }
    catch (error) {
        console.error(`[fileUtils] Error saving file to ${fullFilePath}:`, error);
        throw new Error(`Failed to save file: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Generates a unique filename, typically using a timestamp and a random suffix.
 * @param prefix A prefix for the filename (e.g., 'image', 'video', 'edit').
 * @param extension The file extension (e.g., '.png', '.mp4').
 * @returns A unique filename string.
 */
export function generateUniqueFilename(prefix, extension) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${timestamp}-${randomSuffix}${extension}`;
}
/**
 * Deletes a file.
 * @param filePath The path to the file to delete.
 */
export async function deleteFile(filePath) {
    try {
        await fs.unlink(filePath);
        console.log(`[fileUtils] Deleted file: ${filePath}`);
    }
    catch (error) {
        // Ignore error if file doesn't exist (it might have been cleaned up already)
        if (error.code !== 'ENOENT') {
            console.error(`[fileUtils] Error deleting file ${filePath}:`, error);
            // Decide if you want to throw or just log the error
            // throw new Error(`Failed to delete file: ${error.message}`);
        }
    }
}
//# sourceMappingURL=fileUtils.js.map