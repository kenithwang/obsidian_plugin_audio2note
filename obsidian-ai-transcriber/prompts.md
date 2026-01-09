# Prompts for Audio to Memo Service

## Client Call Mode (`client_call`)

```
Your output must strictly adhere to Markdown formatting.

# [日期] - [项目名] - [客户名] - [客户人名]

| Key                      | Value              |
|--------------------------|--------------------|
| 讨论项目 (Project in Discussion)    | [项目具体名称]     |
| 时间 (Time)                     | [会议具体日期和时间]     |
| 我方参会人 (Participants from BDA)    | [我方参会者姓名列表，用逗号分隔] |
| 客户方参会人 (Participants from Client) | [客户方参会者姓名列表，用逗号分隔] |

## To-do (待办事项)
你是一个专业的会议记录助手。请根据提供的会议【逐字稿】：
从逐字稿中提取所有行动项，并用【简体中文】书写。如果行动项有层级关系，请使用嵌套列表表示。
*   [行动项1]
    *   [子行动项1.1]
*   [行动项2]

## To Be Noticed (重点关注)
识别客户是否满意，对哪些地方不满意，哪些是他更感兴趣的话题，哪些没有那么感兴趣。用【简体中文】书写。
*   [客户满意度及关注点分析]

## Key Points (关键点)
从逐字稿中提取所有关键讨论点，并用【简体中文】书写。如果关键点有层级关系，请使用嵌套列表表示。
*   [关键点1]
    *   [子关键点1.1]
*   [关键点2]

## Discussion (讨论内容)
请根据下面提供的会议【逐字稿】进行处理：
1.  **语言处理**: 如果原始对话主要是**英文**，则保留英文。如果原始对话主要是**简体中文**或**繁体中文**，则统一转换为**简体中文**。如果是其他语言，则翻译为**简体中文**。
2.  **发言人识别与格式化**: 分析逐字稿内容，识别发言人。如果能明确识别发言人姓名（通过自我介绍或他人介绍），请使用其【真实姓名】（例如："张三:" 或 "John Doe:")作为标记。如果无法确切知道姓名，则使用通用标记（例如：A:, B:, C:）。
3.  **语义分段**: 将对话内容严格按照语义变化进行分段。**当说话人改变时，或者当讨论的主题发生显著变化时，开始新的段落。** 避免输出大块连续文本，通过清晰的段落划分提高可读性。
4.  **内容呈现**: 将处理后的逐字稿完整粘贴在此处。

{transcript_placeholder}
```

---

## Market View Mode (`market_view`)

```
Please generate a concise, clear, and professional meeting memo based on the following meeting audio transcript.
The memo should be primarily in Simplified Chinese, with English terms used where appropriate (like names, specific technical terms). The output must strictly adhere to Markdown formatting.
Output Structure:

摘要 (Summary)
(Provide a brief narrative paragraph summarizing the main points and outcomes of the meeting in Simplified Chinese.)

关键要点 (Key Takeaways)
(List the core conclusions, decisions, or significant points discussed using bullet points in Simplified Chinese.)
要点 1
要点 2
...

关键议题 (Key Topics)
(Identify the main topics discussed. For each topic, summarize the viewpoints expressed by different speakers (using their identified names or A, B, C markers). Highlight agreements and disagreements where applicable. Only mention speakers who actively contributed to the discussion on that specific topic. Use Simplified Chinese.)
[议题名称]:
...
[议题名称]:
...
...

详细转录记录 (Detailed Transcript - Polished & Segmented)
(Based on the 'Original Transcript Text' provided below:
Language Preservation and Translation: If the original dialogue is primarily English, keep it English. If the original dialogue is primarily Simplified Chinese or Traditional Chinese, keep it Simplified Chinese. If it's another language, translate the dialogue to Simplified Chinese.
Slightly polish the dialogue for better readability and fluency. Remove excessive colloquialisms, repetitions, and filler words (like "um", "uh", "hmm", "ah", "er"), while strictly preserving the original meaning and intent.
Identify Speakers and Format: Analyze the transcript content for speaker introductions (self-introductions or introductions by others). Whenever a speaker's name is clearly identifiable, use their actual name (e.g., "张三:", "John Doe:") as the speaker marker. Only use generic markers (A:, B:, C:, etc.) for speakers whose names cannot be confidently determined from the dialogue. Format the polished dialogue using these identified or generic speaker markers.
Semantic Paragraph Segmentation: Strictly segment the dialogue into natural paragraphs based on semantic shifts. Start a new paragraph each time the speaker changes or when the topic shifts significantly. Avoid outputting large, continuous blocks of text; prioritize readability through clear paragraph breaks.)
Original Transcript Text:
{transcript_placeholder}
Please ensure the output is in Simplified Chinese for the main sections (Summary, Key Takeaways, Key Topics) as specified, and the Detailed Transcript is either English (if original was English) or Simplified Chinese (otherwise). Use Markdown formatting throughout, and accurately reflect the content of the transcript while incorporating the requested polishing and formatting for the Detailed Transcript section.
```

---

## Project Kickoff Mode (`project_kickoff`)

```
Your output must strictly adhere to Markdown formatting.

# [日期] - [项目名] - [客户名] - [客户人名]

| Key                      | Value              |
|--------------------------|--------------------|
| 讨论项目 (Project in Discussion)    | [项目具体名称]     |
| 时间 (Time)                     | [会议具体日期和时间]     |
| 我方参会人 (Participants from BDA)    | [我方参会者姓名列表，用逗号分隔] |
| 客户方参会人 (Participants from Client) | [客户方参会者姓名列表，用逗号分隔] |

## Background Info (背景信息)
你是一个专业的会议记录助手。请根据提供的会议【逐字稿】：
从逐字稿中提取所有与客户背景或项目背景有关的信息，并用【简体中文】书写。如果信息之间有层级关系，请使用嵌套列表表示。
*   [背景信息1]
    *   [子背景信息1.1]
*   [背景信息2]

## Key Focus (主要关注点)
从逐字稿中，提取客户关注的重点是哪些工作内容。请用清晰的列表展示出来。用【简体中文】书写。
*   [关注点1]
    *   [子关注点1.1]
*   [关注点2]

## Project Detail (项目细节)
从逐字稿中提取，上述主要关注点外，与项目执行相关的细节信息。这里包括项目期望什么时候开始，什么时候结束，客户可以接受几周。项目的budget大概可以接受多少，费用接受多少，以及客户当时对费用的反馈信息。客户期待用什么方式交付报告，等等和项目有关但是又和上面背景信息与关注点无关的信息。并用【简体中文】书写。如果关键点有层级关系，请使用嵌套列表表示。
*   [细节1]
    *   [子细节1.1]
*   [细节2]

## Discussion (讨论内容)
请根据下面提供的会议【逐字稿】进行处理：
1.  **语言处理**: 如果原始对话主要是**英文**，则保留英文。如果原始对话主要是**简体中文**或**繁体中文**，则统一转换为**简体中文**。如果是其他语言，则翻译为**简体中文**。
2.  **发言人识别与格式化**: 分析逐字稿内容，识别发言人。如果能明确识别发言人姓名（通过自我介绍或他人介绍），请使用其【真实姓名】（例如："张三:" 或 "John Doe:"）作为标记。如果无法确切知道姓名，则使用通用标记（例如：A:, B:, C:）。
3.  **语义分段**: 将对话内容严格按照语义变化进行分段。**当说话人改变时，或者当讨论的主题发生显著变化时，开始新的段落。** 避免输出大块连续文本，通过清晰的段落划分提高可读性。
4.  **内容呈现**: 将处理后的逐字稿完整粘贴在此处。

{transcript_placeholder}
```

---
<!-- 你可以在此文件末尾添加新的 Prompt 模式，确保使用类似的 Markdown 格式，
     并通过标题指明其 mode 字符串，例如：
## New Mode Name (`new_mode_identifier`)
```
[Prompt content for new_mode_identifier]
{transcript_placeholder}
```
--> 