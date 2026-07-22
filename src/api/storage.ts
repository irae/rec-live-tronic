import { chmod, link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

export async function storeCookieAtomically(directory: string, id: string, content: Buffer): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o770 });
  await chmod(directory, 0o770);
  const temporary = join(directory, `.${id}.${process.pid}.${Date.now()}.tmp`);
  const destination = join(directory, id);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o660);
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(0o660);
    await handle.close();
    handle = undefined;
    // link() publishes the final pathname only when it does not already exist.
    // Unlike rename(), it cannot replace a cookie selected by an ID collision.
    await link(temporary, destination);
    await unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
