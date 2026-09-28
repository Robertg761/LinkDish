import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number.parseInt(process.env.PORT || "4173", 10);
const siteRoot = path.resolve(fileURLToPath(new URL("../site/", import.meta.url)));
const contentTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"]
]);

const resolveRequest = async (requestUrl) => {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(requestUrl || "/", "http://localhost").pathname);
  } catch {
    return null;
  }

  let filePath = path.resolve(siteRoot, `.${pathname}`);

  if (filePath !== siteRoot && !filePath.startsWith(`${siteRoot}${path.sep}`)) {
    return null;
  }

  try {
    const details = await stat(filePath);

    if (details.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const fileDetails = await stat(filePath);
    return fileDetails.isFile() ? { filePath, statusCode: 200 } : null;
  } catch {
    return null;
  }
};

const server = createServer(async (request, response) => {
  const resolved = await resolveRequest(request.url);
  const filePath = resolved?.filePath || path.join(siteRoot, "404.html");
  const statusCode = resolved?.statusCode || 404;
  const contentType = contentTypes.get(path.extname(filePath).toLowerCase());

  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": contentType || "application/octet-stream",
    "x-content-type-options": "nosniff"
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`LinkDish public site: http://localhost:${port}`);
});
