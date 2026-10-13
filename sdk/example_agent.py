from sdk import AgentTrace


def search_policy(question):
    knowledge = {"cancel_order": "未发货订单请在订单详情页申请取消。助手未执行订单修改。"}
    return knowledge.get("cancel_order") if "取消" in question else None


def main():
    question = "我想取消未发货的订单"
    with AgentTrace("外部 Python 客服 Agent", inputs={"question": question}, attributes={"implementation": "本地函数调用示例，无 LLM 或订单权限"}) as trace:
        with trace.step("查询政策工具", "tool", {"query": question}) as tool:
            policy = search_policy(question)
            tool.output({"policy": policy})
        with trace.step("决定回答还是升级", "routing", {"policyAvailable": policy is not None}) as decision:
            response = policy or "未找到政策，请人工核实。"
            decision.output({"answer": response, "handoffExecuted": False})
        trace.output({"answer": response})
    print("Trace 已保存在本机：", trace.id)


if __name__ == "__main__":
    main()
