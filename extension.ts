import { fileURLToPath } from "node:url";
import {
  createOmpMentionFsExtension,
  type OmpExtensionApi,
} from "./packages/pi-provider/src/index.ts";

const install = createOmpMentionFsExtension({
  binary: fileURLToPath(new URL("./target/release/mention-fs", import.meta.url)),
  settle: "complete",
});

export default function mentionFs(omp: OmpExtensionApi): void {
  install(omp);
}
