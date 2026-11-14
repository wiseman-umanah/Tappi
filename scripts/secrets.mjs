// Creates .env.local from .env.example (if missing) and fills in any empty secrets.
//   pnpm secrets
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = '.env.local';
if (!existsSync(FILE)) {
  copyFileSync('.env.example', FILE);
  console.log(`• created ${FILE} from .env.example`);
}

let text = readFileSync(FILE, 'utf8');
for (const name of ['SESSION_SECRET']) {
  const line = new RegExp(`^${name}=(.*)$`, 'm');
  const current = text.match(line)?.[1]?.trim();
  if (current) {
    console.log(`• ${name} already set — left unchanged`);
    continue;
  }
  const value = randomBytes(32).toString('base64');
  text = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`;
  console.log(`• generated ${name}`);
}
writeFileSync(FILE, text);
