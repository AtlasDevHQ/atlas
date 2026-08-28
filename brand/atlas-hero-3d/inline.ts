/**
 * Substitutes the three bundle, the geometry and the textures into
 * src/template.html and writes atlas-hero.html.
 *
 * The three placeholders are the only coupling between this script and the
 * template: `\/*__THREE__*\/`, `\/*__GLB__*\/` and `\/*__TEX__*\/`.
 */
const DIR = new URL(".", import.meta.url).pathname;
const SRC = `${DIR}src/`;

const TEXTURES = ["body_base", "body_norm", "sphere_base", "sphere_norm"] as const;

async function b64(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return Buffer.from(bytes).toString("base64");
}

const template = await Bun.file(`${SRC}template.html`).text();

// A literal </script> inside the bundle would close the tag early.
const three = (await Bun.file(`${SRC}three-bundle.js`).text()).replaceAll("</script", "<\\/script");

const glb = await b64(`${SRC}atlas-geo.glb`);
const textures: Record<string, string> = {};
for (const name of TEXTURES) textures[name] = await b64(`${SRC}tex_${name}.webp`);

for (const [label, token] of [["three", "/*__THREE__*/"], ["glb", "/*__GLB__*/"], ["tex", "/*__TEX__*/"]] as const) {
  if (!template.includes(token)) throw new Error(`template.html is missing the ${label} placeholder ${token}`);
}

const page = template
  .replace("/*__THREE__*/", three)
  .replace("/*__GLB__*/", glb)
  .replace("/*__TEX__*/", JSON.stringify(textures));

const out = `${DIR}atlas-hero.html`;
await Bun.write(out, page);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`  three ${mb(three.length)} · geometry ${mb(glb.length)} · textures ${mb(
  Object.values(textures).reduce((a, t) => a + t.length, 0),
)}`);
console.log(`  page  ${mb(page.length)} (Artifact cap is 16 MB)`);
