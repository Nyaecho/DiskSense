/**
 * fnmatch 风格通配符匹配（对应 Python fnmatch.fnmatch）。
 * 支持 * ? [seq] [!seq]；Windows 场景统一大小写不敏感。
 */

const cache = new Map<string, RegExp>();

function compile(pattern: string, caseSensitive: boolean): RegExp {
  const key = `${caseSensitive ? "s" : "i"}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      re += "[^\\\\/]*";
    } else if (c === "?") {
      re += "[^\\\\/]";
    } else if (c === "[") {
      let j = i + 1;
      let body = "";
      if (j < pattern.length && pattern[j] === "!") {
        body += "^";
        j++;
      }
      if (j < pattern.length && pattern[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        const ch = pattern[j]!;
        body += /[\\^\]$+]/.test(ch) ? `\\${ch}` : ch;
        j++;
      }
      if (j < pattern.length) {
        // 找到闭合 ]
        re += `[${body}]`;
        i = j;
      } else {
        re += "\\[";
      }
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
    }
  }

  const regex = new RegExp(`^${re}$`, caseSensitive ? "" : "i");
  cache.set(key, regex);
  return regex;
}

/** 大小写不敏感的 fnmatch（等价 Python fnmatch.fnmatch） */
export function fnmatch(name: string, pattern: string): boolean {
  return compile(pattern, false).test(name);
}

/** 大小写敏感的 fnmatch（等价 Python fnmatch.fnmatchcase） */
export function fnmatchCase(name: string, pattern: string): boolean {
  return compile(pattern, true).test(name);
}
