/**
 * Uploads a file (image or video) from a local path to Cloudflare ImgBed.
 *
 * @param filePath The local path to the file to upload.
 * @returns The public URL of the uploaded file on CF ImgBed, or null if upload fails or is skipped.
 */
export declare function uploadToCfImgbed(filePath: string): Promise<string | null>;
