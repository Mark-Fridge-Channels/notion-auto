function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomIntInclusive(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function maybe(arr: readonly string[], p = 0.5): string {
  return Math.random() < p ? pick(arr) : "";
}

const contextList = [
  "从目前情况来看", "看起来现在状态还不错", "我这边简单看了一下",
  "基于当前的执行结果", "按现在这个进度", "目前没有看到明显问题",
  "整体流程看起来是通的", "从现在的反馈来看", "目前这个阶段还算稳定",
  "从整体逻辑上来说", "当前执行路径是正常的", "从已有结果判断",
  "现在这个状态基本是可控的", "整体来看没有偏差", "从现有信息来看",
  "from what I can see", "based on the current state",
  "it looks like everything is working fine", "so far things seem stable",
  "given how things are going", "from my perspective",
  "everything looks aligned", "based on what we have now",
  "it seems consistent so far", "nothing looks off at the moment",
] as const;

const toneList = [
  "应该没什么问题", "基本可以继续", "大概率是OK的", "可以放心往下走",
  "问题不大", "可以继续推进", "看起来是没问题的", "应该可以正常运行",
  "整体来说是稳定的", "基本是符合预期的", "可以按这个节奏继续",
  "目前看不出有什么风险", "整体感觉是正常的",
  "should be fine", "probably okay", "you should be good to go",
  "it seems safe to continue", "looks fine to proceed",
  "there shouldn't be any issue", "everything seems under control",
  "it looks safe enough", "you’re probably fine to move on",
] as const;

const actionList = [
  "继续执行后面的流程", "把整个流程走一遍", "往下推进处理",
  "把这一步完整做完", "执行一下当前这段逻辑", "把核心流程跑一遍",
  "继续把剩下的步骤完成", "按顺序把流程推进下去",
  "把这一轮操作完整跑完", "继续处理后面的逻辑",
  "把当前流程再过一遍确认", "往后继续执行任务",
  "continue with the process", "go ahead and run the full flow",
  "proceed with the next steps", "execute the remaining steps",
  "run through the process", "keep the process going",
  "move forward with the flow", "complete the remaining steps",
  "run the full sequence", "continue the execution path",
] as const;

const extraList = [
  "不用做额外调整", "不需要额外处理", "按现在这样就可以",
  "保持当前逻辑就好", "不用太复杂", "简单确认一下就行",
  "基本不用改什么", "整体可以保持不变", "不需要特别处理",
  "只要确认一下关键点就可以", "不需要额外优化",
  "no extra changes needed", "you don’t need to adjust anything",
  "just a quick check should be enough", "nothing special required",
  "no further action needed", "you can leave it as is",
  "no need for extra work", "just keep it simple",
] as const;

const humanFillers = [
  "其实", "你可以", "一般来说", "说实话", "大概",
  "严格来说", "换个角度看", "简单来说", "从经验来看",
  "正常情况下", "通常来说",
] as const;

const connectors = ["，", "，然后", "，接着", "，最后", "，顺便", " ", " and ", " then "] as const;

function buildSentence(): string {
  const parts = [
    maybe(contextList, 0.9),
    maybe(toneList, 0.9),
    pick(actionList),
    maybe(extraList, 0.7),
  ].filter(Boolean);

  while (parts.length < 3) {
    parts.push(pick(extraList));
  }

  let sentence = parts[0]!;
  for (const p of parts.slice(1)) {
    sentence += pick(connectors) + p;
  }

  if (Math.random() < 0.5) {
    sentence = pick(humanFillers) + sentence;
  }
  return sentence.trim() + " @";
}

const synonyms: Record<string, readonly string[]> = {
  "继续执行后面的流程": ["继续往下走流程", "把后面的流程继续跑下去"],
  "把整个流程走一遍": ["把流程完整过一遍", "走一遍完整流程"],
  "往下推进处理": ["继续往下推进", "往后处理下去"],
  "执行一下当前这段逻辑": ["跑一下当前逻辑", "把这段逻辑执行一下"],
  "继续把剩下的步骤完成": ["把剩余步骤完成", "继续处理剩下部分"],
  "run through the process": ["go through the process", "run the full process"],
  "continue with the process": ["keep the process going", "move forward with it"],
  "should be fine": ["should be okay", "looks fine"],
  "probably okay": ["likely fine", "should work"],
};

const prefixes = [
  "其实", "你可以", "一般来说", "说实话", "大概",
  "从经验来看", "正常情况下", "换个角度说",
] as const;

const suffixes = [
  "基本就可以", "问题不大", "应该OK", "就行",
  "整体没啥问题", "基本能跑通", "不会有太大影响",
] as const;

const evaluationTaskList = [
  "任务运行得不错，继续保持这个节奏",
  "当前执行质量很好，按这个方式推进",
  "这轮任务结果挺稳定，继续往下做",
  "整体反馈很好，当前流程可以继续",
  "任务执行表现不错，不需要额外调整",
  "目前状态很好，后续按同样方式处理",
  "这次执行很顺，按当前节奏继续就行",
  "运行结果符合预期，可以放心推进下一步",
  "这一轮输出质量不错，继续保持稳定",
  "任务衔接很流畅，整体状态在线",
  "执行过程很稳，暂时不需要改动策略",
  "当前任务完成度不错，继续按计划走",
  "这轮执行反馈积极，可以继续推进",
  "目前流程表现良好，维持现有方式即可",
  "任务推进效率不错，继续按现在的路径执行",
  "看起来整体效果很好，后续继续同样动作",
  "本轮任务进展顺利，无需额外处理",
  "当前运行状态优良，下一步可直接继续",
  "这次任务执行稳定，先按原计划推进",
  "最近几轮表现不错，保持节奏即可",
  "运行质量在线，当前逻辑可以继续使用",
  "任务整体效果良好，继续执行后续步骤",
  "这轮处理结果不错，先不做额外调整",
  "执行链路很顺畅，可以继续推进任务",
  "当前表现稳定，维持现有策略就好",
  "这次执行体验很好，继续按当前流程走",
  "整体完成质量不错，继续往下推进",
  "任务结果比较理想，继续保持这个方向",
  "这轮工作状态很好，下一步可直接执行",
  "当前进度和质量都不错，继续保持",
  "任务运行平稳，继续按既定节奏推进",
  "这波执行质量很高，可以继续复制当前做法",
  "任务执行反馈良好，当前方案可继续沿用",
  "当前整体状态优秀，继续向后推进即可",
  "这轮任务达成效果不错，维持现状即可",
  "执行表现持续稳定，可以继续跑后续流程",
  "the task is running well, keep going",
  "execution quality looks good, continue as is",
  "results are stable so far, proceed with confidence",
  "great progress so far, keep the same pace",
  "the workflow looks healthy, continue forward",
  "this run looks solid, no adjustments needed",
  "quality is consistent, proceed to the next step",
  "everything is on track, keep the process moving",
  "current performance is strong, stay on this path",
  "the execution is smooth, continue as planned",
  "output quality is good, maintain the current approach",
  "things are going well, proceed without changes",
  "the task outcome looks good, keep pushing forward",
  "this round is stable, continue with confidence",
  "the overall run quality is high, keep it up",
  "current results look reliable, continue the sequence",
  "execution is steady, no extra action required",
  "the run is in great shape, proceed to next actions",
] as const;

// 评价文案穿插频率：先生成 1～3 条正常任务，再插入 1 条评价文案（评价文案不带 @）
let normalTasksBeforeNextEvaluation = randomIntInclusive(1, 3);

function shouldEmitEvaluationTask(): boolean {
  if (normalTasksBeforeNextEvaluation <= 0) {
    normalTasksBeforeNextEvaluation = randomIntInclusive(1, 3);
    return true;
  }
  normalTasksBeforeNextEvaluation -= 1;
  return false;
}

function replaceSynonyms(text: string): string {
  let out = text;
  for (const [k, values] of Object.entries(synonyms)) {
    if (out.includes(k) && Math.random() < 0.7) {
      out = out.replace(k, pick(values));
    }
  }
  return out;
}

function shuffleClauses(text: string): string {
  const parts = text.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 2 && Math.random() < 0.6) {
    for (let i = parts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [parts[i], parts[j]] = [parts[j]!, parts[i]!];
    }
    return parts.join("，");
  }
  return text;
}

function addTone(text: string): string {
  let out = text;
  if (Math.random() < 0.5) out = pick(prefixes) + out;
  if (Math.random() < 0.5) out = out + "，" + pick(suffixes);
  return out;
}

function cleanSpacing(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function rewrite(sentence: string): string {
  let core = sentence.slice(0, -1).trim();
  core = replaceSynonyms(core);
  core = shuffleClauses(core);
  core = addTone(core);
  core = cleanSpacing(core);
  return core + " @";
}

export function generateTaskContent(): string {
  if (shouldEmitEvaluationTask()) {
    return pick(evaluationTaskList);
  }
  let base = buildSentence();
  if (Math.random() < 0.8) {
    base = rewrite(base);
  }
  return base;
}
