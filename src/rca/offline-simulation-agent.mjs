export class OfflineSimulationAgent {
  constructor({ logger } = {}) {
    this.logger = logger;
  }

  modelInfo() {
    return {
      runtime: "offline deterministic RCA simulation",
      provider: "none",
      modelId: "none",
      nativeToolCalling: false,
      toolMode: "application-level structured actions",
      limitation: "This run validates orchestration and evidence flow; no LLM inference is performed.",
    };
  }

  async invoke({ phase }) {
    let result;
    if (phase === "scoring_gap") {
      result = {
        targetId: "target-gt-1",
        criterion: {
          id: "GT-1",
          text: "Self-Employed(或个体经营者)用于Debt Consolidation(或债务重组)的Personal Loan(或个人贷款)增多",
          officialVerdict: "未命中",
          officialGraderReason: "报告提及债务重组用途的个人贷款申请量增多，但未体现Self-Employed（个体经营者）主体限定。",
        },
        requiredState: {
          summary: "2023年5月，Self-Employed（个体经营者）用于Debt Consolidation（债务重组）的Personal Loan（个人贷款）增多。",
          elements: [
            { description: "时间为2023年5月", source: { type: "query", excerpt: "23年5月" } },
            { description: "主体为Self-Employed或个体经营者", source: { type: "ground_truth", excerpt: "Self-Employed(或个体经营者)" } },
            { description: "用途为Debt Consolidation或债务重组", source: { type: "ground_truth", excerpt: "Debt Consolidation(或债务重组)" } },
            { description: "类型为Personal Loan或个人贷款", source: { type: "ground_truth", excerpt: "Personal Loan(或个人贷款)" } },
            { description: "数量增多", source: { type: "ground_truth", excerpt: "增多" } },
          ],
        },
        answerState: {
          summary: "IDA呈现了2023年5月Debt Consolidation用途的Personal Loan增加，但没有呈现Self-Employed主体限定。",
          relevantExcerpts: [
            { quote: "5月的增量几乎全部来自「个人贷 + 债务重组（Debt Consolidation）」这一组合。" },
            { quote: "该组合当月申请量从常态约190笔涨到304笔（+56%）" },
          ],
        },
        difference: {
          summary: "IDA呈现了时间、贷款类型、用途及数量变化，没有呈现Self-Employed主体限定。",
          requiredButNotPresent: ["发生该变化的贷款主体为Self-Employed（个体经营者）"],
          presentAndRelevant: ["2023年5月", "Personal Loan", "Debt Consolidation", "数量增加"],
        },
        phenomenonToExplain: "解释IDA的运行过程如何产生以下最终状态：最终答案识别并分析了2023年5月Debt Consolidation用途的Personal Loan增多，但没有呈现评分项要求的Self-Employed主体限定。",
      };
    } else if (phase === "investigation_round_1") {
      result = {
        analysisSummary: "先重建IDA已输出的宽泛结论来源，并盘点所有SQL实际分析维度；此时不判断原因。",
        actualAnswerPathStatus: "已从执行地图看到贷款类型和用途分析链，但尚未核对原始查询。",
        requiredFactPathStatus: "尚未确认主体维度是否在数据和请求中出现。",
        openQuestions: ["哪些SQL生成了Personal Loan与Debt Consolidation结论？", "全部SQL是否使用就业维度？"],
        actions: [
          { tool: "list_tool_queries", arguments: {}, purpose: "盘点全部SQL请求及分析维度" },
          { tool: "search_trace", arguments: { query: "Debt Consolidation", scope: "primary", fields: ["input", "output"], maxHits: 20 }, purpose: "定位IDA已采用的Debt Consolidation事实链" },
          { tool: "search_trace", arguments: { query: "Personal Loan", scope: "primary", fields: ["input", "output"], maxHits: 20 }, purpose: "定位IDA已采用的Personal Loan事实链" },
        ],
        readyForConclusion: false,
        proposedEvidenceBoundary: "目前只看到执行地图，不能判断主体限定在哪一阶段丢失。",
      };
    } else if (phase === "investigation_round_2") {
      result = {
        analysisSummary: "已确认IDA实际沿贷款类型和贷款用途形成宽泛结论；接下来确定主体信息是否存在于完整Trace及数据Schema。",
        actualAnswerPathStatus: "贷款类型比较与贷款用途聚合构成已输出事实的主要上游。",
        requiredFactPathStatus: "11个SQL请求中未观察到就业状况字段，但需检查Schema可用性和全部原始Span。",
        openQuestions: ["Self-Employed是否以原值出现？", "就业状况字段是否曾向模型暴露？"],
        actions: [
          { tool: "search_trace", arguments: { query: "Self-Employed", scope: "all", fields: ["input", "output"], maxHits: 30 }, purpose: "完整搜索Self-Employed原值，不能仅搜索摘要" },
          { tool: "search_trace", arguments: { query: "就业状况", scope: "all", fields: ["input", "output"], maxHits: 30 }, purpose: "检查就业状况字段的可用性及上下文传播" },
          { tool: "get_tool_exchange", arguments: { spanId: "3d1358b5940c2b9a", outputLength: 7000 }, purpose: "读取数据集Schema Tool请求与结果，验证主体维度是否可用" },
        ],
        readyForConclusion: false,
        proposedEvidenceBoundary: "可以检查字段是否可用，但尚不能解释为什么未被采用。",
      };
    } else if (phase === "investigation_round_3") {
      result = {
        analysisSummary: "Schema明确包含就业状况，完整Trace未出现Self-Employed原值；需要核查关键用途SQL和最终输出，连接上下游影响。",
        actualAnswerPathStatus: "宽泛结论来自对Personal Loan按贷款用途聚合。",
        requiredFactPathStatus: "就业状况字段进入多次Generation上下文，但尚未看到任何查询对其聚合。",
        openQuestions: ["关键用途SQL是否只按用途分组？", "最终Generation是否确实没有主体限定？"],
        actions: [
          { tool: "get_tool_exchange", arguments: { spanId: "33098cd31a5d0ce9", outputLength: 8000 }, purpose: "验证形成Debt Consolidation结论的SQL请求、分组维度和结果" },
          { tool: "get_span_content", arguments: { spanId: "42c3c1457afb17c9", field: "output", start: 0, length: 7000 }, purpose: "读取最终Generation原文确认最终事实状态" },
          { tool: "get_span_content", arguments: { spanId: "bb113e31c1f190c5", field: "output", start: 0, length: 5000 }, purpose: "查看选择人群特征分析维度时的显式计划与Tool请求" },
        ],
        readyForConclusion: false,
        proposedEvidenceBoundary: "若关键SQL和最终输出连接成立，可定位执行分叉，但仍需检查后续是否有替代查询。",
      };
    } else if (phase === "investigation_round_4") {
      result = {
        analysisSummary: "关键用途SQL只按月份和贷款用途聚合；最终输出沿用该宽泛结果。再核查后续Debt Consolidation确认SQL及用途规划，排除另一路径曾计算主体组合。",
        actualAnswerPathStatus: "已连接用途查询、用途结论和最终答案。",
        requiredFactPathStatus: "字段可用且在模型上下文出现，但SQL层没有生成按就业状况限定的组合统计。",
        openQuestions: ["后续确认SQL是否补查就业维度？", "选择用途结构时是否出现过主体分析意图？"],
        actions: [
          { tool: "get_span_content", arguments: { spanId: "bfeadf2e1dce1570", field: "output", start: 0, length: 5000 }, purpose: "检查进入用途分析前的显式调查选择" },
          { tool: "get_tool_exchange", arguments: { spanId: "b4027e9929651f5a", outputLength: 9000 }, purpose: "核查后续Debt Consolidation确认SQL是否包含就业维度" },
          { tool: "search_trace", arguments: { query: "employment", scope: "all", fields: ["input", "output"], maxHits: 30 }, purpose: "排除英文employment字段或同义字段被另一分支使用" },
        ],
        readyForConclusion: true,
        proposedEvidenceBoundary: "可将最早实质分叉定位为分析规划选择未覆盖就业状况维度；无法从Trace证明模型为何作出该选择。",
      };
    } else if (phase === "final_rca") {
      result = {
        caseId: "session-29785869-gt-1",
        executiveSummary: "在现有Trace可观察边界内，IDA先按贷款类型定位Personal Loan异常，再按贷款用途定位Debt Consolidation，并据此形成最终宽泛结论。数据Schema已向IDA提供就业状况字段，但后续分析规划和全部11个SQL均未使用该维度，因此运行过程中没有生成Self-Employed + Debt Consolidation + Personal Loan的组合统计，最终答案也无法保留该主体限定。Trace可以确认分叉发生在分析维度选择/查询规划阶段，但不能证明模型为什么没有选择就业状况维度。",
        scoreGap: { criterionId: "GT-1", observedDifference: "答案呈现Debt Consolidation用途的Personal Loan增加，但没有Self-Employed主体限定。" },
        actualAnswerProductionChain: [
          { step: "执行链先比较贷款类型，定位Personal Loan异常。", evidenceIds: ["EV-002", "EV-003", "EV-005"] },
          { step: "随后按贷款用途聚合Personal Loan高利贷，Debt Consolidation成为突出用途。", evidenceIds: ["EV-004", "EV-009", "EV-012"] },
          { step: "最终Generation将该用途级结论写入答案。", evidenceIds: ["EV-010"] },
        ],
        requiredFactLifecycle: [
          { stage: "data availability", finding: "Schema包含就业状况字段。", status: "present", evidenceIds: ["EV-007", "EV-008"] },
          { stage: "planning", finding: "显式人群特征计划选择地区、信用、欺诈、用途等，但未提出就业状况拆解。", status: "absent", evidenceIds: ["EV-011", "EV-012"] },
          { stage: "tool request", finding: "全部11个SQL没有使用就业状况字段。", status: "absent", evidenceIds: ["EV-003", "EV-009", "EV-013"] },
          { stage: "tool result", finding: "现有SQL结果没有生成Self-Employed组合统计；完整Trace中未出现Self-Employed原值。", status: "absent", evidenceIds: ["EV-006", "EV-009", "EV-013"] },
          { stage: "context propagation", finding: "就业状况作为Schema字段进入多个上下文，但没有主体组合统计可向后传播。", status: "present", evidenceIds: ["EV-007", "EV-008"] },
          { stage: "intermediate conclusion", finding: "中间结论收敛到Personal Loan和Debt Consolidation，未形成Self-Employed限定。", status: "absent", evidenceIds: ["EV-004", "EV-005", "EV-011", "EV-012"] },
          { stage: "final answer", finding: "最终Generation没有Self-Employed主体限定。", status: "absent", evidenceIds: ["EV-010"] },
        ],
        earliestMaterialDivergence: {
          finding: "在已知Schema含就业状况的情况下，IDA的人群特征调查计划及其后查询未选择就业状况维度，而转向信用、收入、欺诈、地区和用途。",
          whyMaterial: "从这一点开始，Tool层没有生成按就业状况限定的组合证据，后续模型只能基于更宽泛的贷款类型和用途统计形成结论。",
          evidenceIds: ["EV-003", "EV-008", "EV-011", "EV-012"],
        },
        causalChain: [
          { finding: "Schema向IDA暴露就业状况字段。", evidenceIds: ["EV-008"] },
          { finding: "分析计划未选择就业状况，11个SQL也未使用该字段。", evidenceIds: ["EV-003", "EV-011", "EV-012", "EV-013"] },
          { finding: "用途SQL只生成月份、贷款用途和高利贷笔数，支持宽泛Debt Consolidation结论。", evidenceIds: ["EV-009"] },
          { finding: "最终Generation沿用宽泛结论，没有主体限定。", evidenceIds: ["EV-010"] },
        ],
        alternativeExplanations: [
          { explanation: "数据源没有就业维度", status: "rejected", reason: "Schema明确包含就业状况。", evidenceIds: ["EV-008"] },
          { explanation: "Agent曾在另一SQL分支计算Self-Employed但最终总结删除", status: "rejected", reason: "全部SQL盘点没有就业状况字段，完整Trace也未出现Self-Employed原值。", evidenceIds: ["EV-003", "EV-006", "EV-014"] },
          { explanation: "字段值存在但以未检索到的其他编码表达", status: "possible", reason: "Trace仅记录查询和返回，不包含底层全表值域；没有实际运行就业状况值域查询。", evidenceIds: ["EV-008"] },
          { explanation: "上下文截断删除了已计算的主体结果", status: "rejected", reason: "没有任何SQL生成该主体统计，且完整性检查未观察到Trace载荷截断标记。", evidenceIds: ["EV-001", "EV-003"] },
        ],
        rootCauseAssessment: {
          finding: "可观察根因是分析维度选择和查询规划没有覆盖可用的就业状况维度，导致Self-Employed限定从未形成数据证据，而不是已形成后在最终写作阶段被单独删掉。",
          confidence: "medium",
          evidenceIds: ["EV-003", "EV-006", "EV-008", "EV-009", "EV-010", "EV-011", "EV-012", "EV-013"],
        },
        evidenceBoundary: {
          confirmed: "已确认字段可用、全部SQL未使用该字段、宽泛结论的用途查询来源以及最终答案缺失主体限定。",
          notProven: "无法从现有Trace证明模型内部为何没有选择就业维度，也没有重放验证补充该维度后一定命中GT；底层原始表中Self-Employed的实际组合统计未在本次Trace中计算。",
        },
        recommendedNextVerification: [
          "在相同数据和其余上下文不变时，重放增加就业状况分组的查询，验证Self-Employed + Debt Consolidation + Personal Loan是否确实构成5月增量。",
          "做单变量干预：仅在分析计划中加入就业状况维度，观察最终答案是否稳定命中GT。",
        ],
      };
    } else {
      throw new Error(`Offline simulation has no fixture for phase: ${phase}`);
    }

    await this.logger?.event({
      phase,
      actor: "offline_simulation_agent",
      type: "simulated_agent_response",
      summary: "离线确定性Agent返回测试动作；此事件不是Sophon模型推理结果",
      data: result,
    });
    return result;
  }
}
