/** 单机课程演示用 JSON 文件存储：原子覆盖，写入串行化，无外部依赖。 */
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function openStorage(dir = process.env.DATA_DIR || path.join(process.cwd(), 'data')) {
  const folder = path.resolve(dir);
  const filepath = path.join(folder, 'backend-records.json');
  await mkdir(folder, {recursive:true});
  let state = {version:1, scores:[], reports:[]};
  try {
    const data = JSON.parse(await readFile(filepath, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.scores) || !Array.isArray(data.reports)) throw Error('版本或结构不匹配');
    state = data;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`无法读取存储文件 ${filepath}：${e.message}`);
  }
  let pending = Promise.resolve();
  function persist(change) {
    const work = pending.then(async () => {
      const next = structuredClone(state);
      const result = change(next);
      const temp = filepath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
        await rename(temp, filepath);
      } catch(e) {
        try { await unlink(temp); } catch {}
        throw e;
      }
      state = next;
      return result;
    });
    pending = work.catch(()=>{});
    return work;
  }
  return {
    filepath,
    getScores:()=>structuredClone(state.scores),
    getReports:()=>structuredClone(state.reports),
    addScore:score=>persist(s=>{s.scores.push(score);return score;}),
    addReport:entry=>persist(s=>{s.reports.push(entry);s.reports=s.reports.slice(-300);return entry;})
  };
}
