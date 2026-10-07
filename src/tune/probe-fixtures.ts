import type { JSONSchema7, ToolSet } from "ai";

// Valid, small media fixtures so a ground-truth counter can inspect their data.
const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const PROBE_FILE =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAxMDAgMTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTUgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiAyMCAyMCBUZCAodG9rZW54IGNhbGlicmF0aW9uIHByb2JlKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDE1CiUlRU9GCg==";

const TEXTS: readonly string[] = [
  "The harbor library opens before sunrise. Readers exchange notes about maps, weather, and the boats returning from the islands. A careful estimate helps keep their shared conversation within its budget.",
  "const result = records.filter(record => record.enabled).map(record => ({ id: record.id, label: record.name }));\nif (result.length > 0) {\n  console.log(JSON.stringify(result));\n}\n",
  '{"version":12,"items":[{"id":"alpha","active":true,"score":0.875},{"id":"beta","active":false,"score":0.125}],"metadata":{"region":"north","attempts":1234567890}}',
  "# Field notes\n\n- Check the weather forecast.\n- Compare the two routes.\n\n| Route | Distance |\n| --- | --- |\n| Harbor | 12 |\n| Forest | 34 |\n\nUse **clear descriptions** and `stable identifiers`.",
  "人工智能技术帮助研究人员整理图书资料。天气晴朗的时候，我们沿着河流走到城市中心，讨论数据分析和语言模型。",
  "こんにちは。図書館で新しい資料を調べています。旅行の予定について話し合い、天気と交通の情報を確認してください。",
  "안녕하세요. 도서관에서 새로운 자료를 찾고 있습니다. 여행 계획을 세우면서 날씨와 교통 정보를 확인하고 기록합니다.",
  "Die Größenordnung verändert sich täglich. Überprüfen Sie die ausführliche Beschreibung der öffentlichen Bücher und berücksichtigen Sie ungewöhnliche Möglichkeiten.",
  "Une étude détaillée décrit les échanges à proximité du musée. El diseño de la colección reúne información útil sobre música, árboles y ciudades.",
  "Zażółć gęślą jaźń. Příliš žluťoučký kůň úpěl ďábelské ódy. Właściwości narzędzia opisują różne możliwości wyszukiwania.",
  "Библиотека открывается утром. Исследователи обсуждают результаты измерений, проверяют документы и составляют подробный план путешествия.",
  "Η βιβλιοθήκη ανοίγει το πρωί. Οι ερευνητές εξετάζουν νέες πληροφορίες και καταγράφουν τα αποτελέσματα της συζήτησης.",
  "😀😃😄😁😆😅😂🤣 😊🙂🙃😉😍🥰 😎🤔🧐🤓 👍🏽👍🏾👋🏽 🌳🌲🌴🌵",
  "123456789012345678901234567890 999999999999999 12345 678901234567 3141592653589793238462643383279",
  "------- :::::::::: {{{{{{{{ ((((((((((((( ......... !?!?!?!?!?!?!? ______________ /////////",
  "A Ab Abc Abcd Abcde Abcdef Abcdefgh Abcdefghijk Abcdefghijklmn abc abcd abcdef abcdefgh abcdefghijk abcdefghijklmnop",
];

/** An SDK Schema wrapper without importing the SDK at runtime. */
function createTools(
  schemas: JSONSchema7[],
  descriptions: boolean = false,
): ToolSet {
  return Object.fromEntries(
    schemas.map((jsonSchema, index) => [
      String.fromCharCode(97 + index),
      {
        description: descriptions
          ? `Find records in collection ${index}.`
          : undefined,
        inputSchema: {
          [Symbol.for("vercel.ai.schema")]: true,
          _type: undefined,
          jsonSchema,
          validate: undefined,
        },
      },
    ]),
  ) as ToolSet;
}

export { createTools, PROBE_FILE, PROBE_IMAGE, TEXTS };
