import fs from "node:fs/promises";
import { sendFeishu } from "./feishu.mjs";

const statusFile = process.env.STATUS_FILE || "status.json";
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions`
  : "";

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

async function main() {
  const status = await readStatus();
  const { title, content } = buildMessage(status);
  const sent = await sendFeishu({ title, content });
  if (!sent) {
    process.exitCode = 1;
  }
}

async function readStatus() {
  try {
    return JSON.parse(await fs.readFile(statusFile, "utf8"));
  } catch (error) {
    console.error(`Cannot read status file ${statusFile}: ${error.message}`);
    return null;
  }
}

function buildMessage(status) {
  if (!status) {
    return {
      title: "⚠️ Coze 每日签到异常",
      content: [
        `未找到 ${today} 的签到记录，签到任务可能没有运行。`,
        "请检查 GitHub Actions 中「Coze daily check-in」的运行记录。"
      ].join("\n")
    };
  }

  const accounts = Array.isArray(status.accounts) ? status.accounts : [];
  const successCount = accounts.filter((account) => account.success).length;
  const failedCount = accounts.length - successCount;
  const isToday = status.date === today;
  const allSuccess = accounts.length > 0 && failedCount === 0 && isToday;

  const title = allSuccess ? "✅ Coze 每日签到成功" : "⚠️ Coze 每日签到需要关注";
  const lines = [`日期：${status.date || "未知"}（今天 ${today}）`];

  if (accounts.length === 0) {
    lines.push("没有账号签到结果。");
  } else {
    for (const account of accounts) {
      lines.push(`${account.name}：${account.success ? "成功" : `失败（${account.message || "未知原因"}）`}`);
    }
    lines.push(`合计：成功 ${successCount} / ${accounts.length}`);
  }

  if (!isToday) {
    lines.push("注意：这份记录不是今天的，签到任务可能未按时运行。");
  }
  if (status.error) {
    lines.push(`任务错误：${status.error}`);
  }
  if (status.runUrl) {
    lines.push(`签到运行记录：${status.runUrl}`);
  } else if (runUrl) {
    lines.push(`仓库 Actions：${runUrl}`);
  }

  return { title, content: lines.join("\n") };
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
