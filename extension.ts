import { fileURLToPath } from "node:url";
import {
  createOmpMentionFsExtension,
  type OmpExtensionApi,
} from "./packages/pi-provider/src/index.ts";

const install = createOmpMentionFsExtension({
  binary: fileURLToPath(
    new URL(`./bin/mention-fs-${process.platform}-${process.arch}`, import.meta.url),
  ),
  settle: "complete",
});

export default function mentionFs(omp: OmpExtensionApi): void {
  install(omp);
}
