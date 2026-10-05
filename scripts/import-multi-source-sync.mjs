import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const defaultSource =
	"/Users/shengjie.lin/Desktop/LSJ_test/a_lsj/lsj_100b/.obsidian/plugins/multi-source-sync";
const sourceDir = path.resolve(process.argv[2] ?? defaultSource);
const projectRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(projectRoot, "vendor", "multi-source-sync");
const workbenchStyles = path.join(projectRoot, "styles.css");

const sourceMain = path.join(sourceDir, "main.js");
const sourceStyles = path.join(sourceDir, "styles.css");
const sourceManifest = path.join(sourceDir, "manifest.json");

for (const file of [sourceMain, sourceStyles, sourceManifest]) {
	if (!fs.existsSync(file)) throw new Error(`Missing source-sync artifact: ${file}`);
}

const bundled = fs.readFileSync(sourceMain, "utf8");
const safeStart = bundled.indexOf("const __mssMinimalSettings=");
if (safeStart < 0) {
	throw new Error("The source-sync bundle layout changed; refusing to import it unsafely.");
}

// The local source bundle has two machine-specific startup shims prepended to
// it. They read and rewrite that vault's data.json before Obsidian has even
// constructed the plugin. Flexible Workbench owns persistence for the embedded
// copy, so discard those shims and retain the actual plugin bundle (including
// its intentionally minimal settings UI) from this marker onward.
const sanitizedBundle = bundled.slice(safeStart);
if (
	sanitizedBundle.includes(sourceDir) ||
	/web_session=[0-9a-f]{32}/i.test(sanitizedBundle) ||
	/id_token=[A-Za-z0-9+/]{24,}/.test(sanitizedBundle)
) {
	throw new Error("Sensitive or machine-specific data remained in the sanitized bundle.");
}

const css = fs.readFileSync(sourceStyles, "utf8");
const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
const styleStart = "/* BEGIN embedded multi-source-sync styles (generated) */";
const styleEnd = "/* END embedded multi-source-sync styles (generated) */";
const styleBlock = `${styleStart}\n${css.trim()}\n${styleEnd}`;
const currentStyles = fs.readFileSync(workbenchStyles, "utf8");
const startAt = currentStyles.indexOf(styleStart);
const endAt = currentStyles.indexOf(styleEnd);
let nextStyles;
if (startAt >= 0 && endAt > startAt) {
	nextStyles =
		currentStyles.slice(0, startAt) +
		styleBlock +
		currentStyles.slice(endAt + styleEnd.length);
} else {
	nextStyles = `${currentStyles.trimEnd()}\n\n${styleBlock}\n`;
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "main.js"), sanitizedBundle);
fs.writeFileSync(workbenchStyles, nextStyles);
fs.writeFileSync(
	path.join(outputDir, "source-manifest.json"),
	`${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`Imported ${manifest.name} ${manifest.version} into ${outputDir}`);
