/**
 * 自动提权（UAC）辅助。
 *
 * 非管理员进程遇到需要卷句柄的操作（MFT 直读）时，用 ShellExecuteExW 的
 * `runas` 动词拉起提权子进程重跑同一命令——UAC 弹窗本身就是用户确认。
 * 父进程经 SEE_MASK_NOCLOSEPROCESS 拿到子进程句柄并阻塞等待退出。
 * 用户取消 UAC 时抛 ElevateCancelled，由调用方决定降级策略。
 */

import koffi from "koffi";
import path from "node:path";

const kernel32 = koffi.load("kernel32.dll");
const shell32 = koffi.load("shell32.dll");

const IsUserAnAdmin = shell32.func("__stdcall", "IsUserAnAdmin", "int32", []);
const ShellExecuteExW = shell32.func("__stdcall", "ShellExecuteExW", "int32", ["void *"]);
const WaitForSingleObject = kernel32.func("__stdcall", "WaitForSingleObject", "uint32", [
  "int64", "uint32",
]);
const GetExitCodeProcess = kernel32.func("__stdcall", "GetExitCodeProcess", "int32", [
  "int64", koffi.out(koffi.pointer("uint32")),
]);
const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "int32", ["int64"]);

const SEE_MASK_NOCLOSEPROCESS = 0x00000040;
const INFINITE = 0xffffffff;

export class ElevateCancelled extends Error {}

/** 当前进程是否持有管理员令牌。 */
export function isAdmin(): boolean {
  try {
    return IsUserAnAdmin() !== 0;
  } catch {
    return false;
  }
}

function wideBuf(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, "utf16le"), Buffer.alloc(2)]);
}

/** 手工布局 x64 SHELLEXECUTEINFOW（112 字节）。宽字符缓冲区由调用方持有直至调用完成。 */
function buildSeei(
  fMask: number,
  lpVerb: Buffer,
  lpFile: Buffer,
  lpParameters: Buffer,
  lpDirectory: Buffer
): Buffer {
  const verbAddr = koffi.address(lpVerb);
  const fileAddr = koffi.address(lpFile);
  const paramsAddr = koffi.address(lpParameters);
  const dirAddr = koffi.address(lpDirectory);
  const seei = Buffer.alloc(112);
  seei.writeUInt32LE(112, 0); // cbSize
  seei.writeUInt32LE(fMask, 4); // fMask
  // hwnd @8 = 0
  seei.writeBigUInt64LE(verbAddr, 16); // lpVerb
  seei.writeBigUInt64LE(fileAddr, 24); // lpFile
  seei.writeBigUInt64LE(paramsAddr, 32); // lpParameters
  seei.writeBigUInt64LE(dirAddr, 40); // lpDirectory
  seei.writeUInt32LE(0, 48); // nShow = SW_HIDE
  seei.writeBigUInt64LE(0n, 104); // hProcess（出参）
  return seei;
}

/** 计算提权后子进程的命令参数。 */
export function buildElevatedArgs(cliArgs: readonly string[]): string[] {
  const entry = process.argv[1] ?? "";
  return entry.endsWith(".ts")
    ? ["--import", "tsx", entry, ...cliArgs] // 开发模式：tsx 加载 TS 入口
    : [entry, ...cliArgs];
}

/** 按 Windows 命令行规则转义单个参数（含空白/引号时包裹引号并转义）。 */
export function quoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  for (let i = 0; i < arg.length; i++) {
    let backslashes = 0;
    while (i < arg.length && arg[i] === "\\") {
      backslashes++;
      i++;
    }
    if (i >= arg.length) {
      out += "\\".repeat(backslashes * 2);
    } else if (arg[i] === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + arg[i];
    }
  }
  return out + '"';
}

/**
 * 以管理员身份重新运行当前 CLI，同步阻塞等待其退出。
 *
 * @param cliArgs 追加在入口之后的参数列表（不含入口本身）
 * @returns 子进程退出码
 * @throws ElevateCancelled 用户拒绝 UAC / 提权失败
 */
export function elevateAndWait(cliArgs: readonly string[]): number {
  if (process.platform !== "win32") throw new ElevateCancelled("仅 Windows 支持 UAC 提权");
  const args = buildElevatedArgs(cliArgs);
  const lpVerb = wideBuf("runas");
  const lpFile = wideBuf(process.execPath);
  const lpParameters = wideBuf(args.map(quoteArg).join(" "));
  const entry = process.argv[1] ?? "";
  const lpDirectory = wideBuf(entry ? path.dirname(entry) : path.dirname(process.execPath));
  const seei = buildSeei(SEE_MASK_NOCLOSEPROCESS, lpVerb, lpFile, lpParameters, lpDirectory);
  const ok = ShellExecuteExW(seei);
  void lpVerb;
  void lpFile;
  void lpParameters;
  void lpDirectory;
  const hProcess = seei.readBigUInt64LE(104);
  if (!ok || hProcess === 0n) {
    // 失败路径：SE_ERR ≤32 表示具体错误（5=用户取消 UAC）
    const seErr = seei.readBigInt64LE(56);
    throw new ElevateCancelled(`UAC 提权未成功（SE_ERR=${seErr}，通常为用户取消）`);
  }
  try {
    WaitForSingleObject(Number(hProcess), INFINITE);
    const codeOut = [0];
    GetExitCodeProcess(Number(hProcess), codeOut);
    return codeOut[0]!;
  } finally {
    CloseHandle(Number(hProcess));
  }
}
