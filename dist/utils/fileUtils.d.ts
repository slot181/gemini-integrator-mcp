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
export declare function saveFile(outputDir: string, subfolder: string, filename: string, data: Buffer): Promise<string>;
/**
 * Generates a unique filename, typically using a timestamp and a random suffix.
 * @param prefix A prefix for the filename (e.g., 'image', 'video', 'edit').
 * @param extension The file extension (e.g., '.png', '.mp4').
 * @returns A unique filename string.
 */
export declare function generateUniqueFilename(prefix: string, extension: string): string;
/**
 * Deletes a file.
 * @param filePath The path to the file to delete.
 */
export declare function deleteFile(filePath: string): Promise<void>;
