const outputDir = Deno.env.get("QUARTO_PROJECT_OUTPUT_DIR") || "_book";
const renderedFiles = (Deno.env.get("QUARTO_PROJECT_OUTPUT_FILES") || "")
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter((file) => file.endsWith(".html"));

// A project manifest describes the complete ordered document, not a partial
// render. Leave an existing complete manifest alone when Quarto renders one
// chapter for preview.
if (Deno.env.get("QUARTO_PROJECT_RENDER_ALL") !== "1") Deno.exit(0);

const inspected = await new Deno.Command("quarto", {
  args: ["inspect"],
  stdout: "piped",
  stderr: "inherit",
}).output();
if (!inspected.success) {
  throw new Error("quarto inspect failed while generating tlda-manifest.json");
}

const config = JSON.parse(new TextDecoder().decode(inspected.stdout));
const bookEntries: Array<{ file: string }> = config?.config?.book?.render || [];
const sourceByOutput = new Map(
  bookEntries.map((entry) => [
    entry.file.replace(/\.(qmd|md|ipynb)$/i, ".html"),
    entry.file,
  ]),
);

function relativeOutputFile(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  const normalizedOutputDir = outputDir.replaceAll("\\", "/").replace(/\/+$/, "");
  const outputDirName = normalizedOutputDir.split("/").pop() || normalizedOutputDir;
  if (normalized.startsWith(`${normalizedOutputDir}/`)) {
    return normalized.slice(normalizedOutputDir.length + 1);
  }
  if (normalized.startsWith(`${outputDirName}/`)) {
    return normalized.slice(outputDirName.length + 1);
  }
  return normalized;
}

function textContent(html: string): string {
  return html
    .replace(/<span[^>]*\bheader-section-number\b[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const pages = [];
for (const renderedFile of renderedFiles) {
  const file = relativeOutputFile(renderedFile);
  const html = await Deno.readTextFile(`${outputDir}/${file}`);
  const chapterTitle = html.match(/<span[^>]*\bclass=["'][^"']*\bchapter-title\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
  const heading = chapterTitle
    || html.match(/<h1(?![^>]*\bclass=["'][^"']*\btitle\b)[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const documentTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const sourceFile = sourceByOutput.get(file)
    || file.replace(/\.html$/i, ".qmd");
  pages.push({
    file,
    title: textContent(heading || documentTitle || file.replace(/\.html$/i, "")),
    source: { type: "project-source", format: "qmd", file: sourceFile },
  });
}

await Deno.writeTextFile(
  `${outputDir}/tlda-manifest.json`,
  `${JSON.stringify({ version: 1, kind: "tlda", pages }, null, 2)}\n`,
);
