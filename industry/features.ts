// 可选模块。它们只对 AI 行业有意义：做别的行业时两项都设为 false，或者按 docs/customize.md 整块删掉。
// 关掉以后：导航里不再出现入口，对应的定时任务不再运行，页面与接口返回 404。

export const FEATURES = {
  /** 模型榜：汇总公开评测，按公开方法 v15 计算共识排名（/leaderboard）。每天抓 4 次评测来源。 */
  leaderboard: false,
  /** Codex 重置监控：盯 OpenAI Codex 负责人在 X 上的额度重置公告（/codex-reset）。需要 SocialData。 */
  codexResetMonitor: false,
  /** 热点榜：多信源事件聚合的 /hot（要求至少两个独立信源）。当前仅单一转载源，撑不起来，默认关。 */
  hotRanking: false,
  /** AI 日报/周报/月报（/daily*）：每天 LLM 撰写报告 + 补漏 + 日报 RSS。2026-10-12 关（砍栏目省 LLM）。 */
  dailyReport: false,
  /** 主题索引（/topics*）与 sync 的精选打标（LLM structure 调用）+ 事件分组入队。2026-10-12 关。 */
  topics: false,
  /** Agent 接入页（/agent 的 Skill 包说明与下载入口）。 */
  agentPack: false,
  /** 更新日志（/changelog）与导航未读点。 */
  changelog: false,
  /** 意见反馈（/feedback）与 Q助理 转发 cron。 */
  feedback: false,
} as const;
