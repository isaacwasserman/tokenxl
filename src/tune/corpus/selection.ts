/** Authored documents reserved for selecting text refinement, never for fitting rules. */
export interface TuningDocument {
  name: string;
  language: string;
  register: "prose" | "code" | "json";
  text: string;
}

export const TEXT_SELECTION_DOCUMENTS: readonly TuningDocument[] = [
  {
    name: "field-repair",
    language: "en",
    register: "prose",
    text: `The maintenance team reached the bridge before the morning traffic. A loose cable had interrupted the temperature readings, but the pressure sensor continued to work. They compared yesterday's measurements with a small portable instrument and wrote down the differences. Each repair needed a clear description, the time it was completed, and the name of the person who checked it. After reconnecting the cable, the team waited for three complete measurement cycles. The first reading was unusually high. The next two readings agreed with the portable instrument. They left the bridge open and scheduled another inspection for Friday. The report explains the uncertainty rather than treating every number as equally reliable.`,
  },
  {
    name: "delivery-de",
    language: "de",
    register: "prose",
    text: `Die Lieferung kam am frühen Nachmittag an. Zwei Mitarbeiter überprüften die Verpackung und verglichen die Stückzahlen mit der Bestellung. Ein beschädigter Karton enthielt drei kleine Geräte, deren Gehäuse jedoch unverletzt waren. Für die Rückmeldung wurden Fotos aufgenommen und die Seriennummern sorgfältig notiert. Anschließend prüfte das Team die Geräte einzeln. Die Anleitung empfahl eine längere Aufwärmzeit, bevor genaue Messungen möglich sind. Während dieser Zeit wurden die übrigen Pakete ins Lager gebracht. Die verantwortliche Kollegin ergänzte den Prüfbericht um die tatsächliche Ankunftszeit und die noch offenen Fragen. Eine endgültige Entscheidung über die beschädigte Verpackung soll erst nach der Rücksprache mit dem Lieferanten getroffen werden.`,
  },
  {
    name: "reservoir-zh",
    language: "zh",
    register: "prose",
    text: `水库管理人员每天早上检查水位、降雨量和设备状态。过去一周的降雨比较集中，部分道路出现了积水，因此巡查路线需要临时调整。工作人员先确认通讯设备能够正常使用，再前往各个测量点。每次测量都要记录时间和天气情况，避免把不同条件下的数据直接进行比较。新的自动系统可以及时发送异常通知，但现场检查仍然十分重要。工程师发现一个传感器的读数与其他设备不一致，于是安排了进一步校准。在确认原因之前，这个读数被单独标注，没有用于计算平均水位。下午的会议讨论了备用电源和维护计划。大家希望通过清楚的记录，让下一班工作人员能够迅速了解当前情况。`,
  },
  {
    name: "clinic-ja",
    language: "ja",
    register: "prose",
    text: `診療所では新しい予約システムの運用を始めました。受付の担当者は、電話で受け付けた予約とオンラインの予約を毎朝確認します。同じ時間に複数の患者が登録されていないか、診察に必要な資料がそろっているかを調べます。初日は確認に時間がかかりましたが、手順を整理すると作業が少しずつ早くなりました。変更があった場合は、理由と連絡した時刻を記録します。急な予定変更でも、次の担当者が状況を理解できるようにするためです。システムの通知だけに頼らず、必要な情報が実際に届いていることも確認します。週末には利用者から寄せられた意見をまとめ、改善できる点を話し合う予定です。`,
  },
  {
    name: "warehouse-ko",
    language: "ko",
    register: "prose",
    text: `창고에서는 매일 출고 전에 주문 내용과 실제 상품을 비교합니다. 담당자는 수량뿐 아니라 포장 상태와 배송 주소도 확인합니다. 최근에는 비슷한 이름의 상품이 잘못 선택되는 일이 있어서 선반 표시를 새로 만들었습니다. 변경 후에는 작업 시간이 조금 줄었지만, 모든 문제가 해결된 것은 아닙니다. 새로운 직원은 아직 상품 위치를 익히는 중이므로 확인 절차를 생략하지 않습니다. 문제가 발견되면 주문 번호와 발생 시간을 기록하고 다음 담당자에게 전달합니다. 주간 회의에서는 이러한 기록을 함께 살펴보며 반복되는 원인을 찾습니다. 단순히 빠르게 처리하는 것보다 정확한 정보를 공유하는 일이 중요하다는 의견이 나왔습니다.`,
  },
  {
    name: "station-fr",
    language: "fr",
    register: "prose",
    text: `À la gare, les voyageurs consultaient les nouveaux horaires affichés près de l'entrée. Un changement de voie avait été annoncé quelques minutes auparavant. L'équipe expliquait calmement la situation et aidait les personnes qui avaient une correspondance. Les informations sur l'écran étaient correctes, mais certaines annonces sonores restaient difficiles à comprendre. Une agente a demandé de répéter le message plus lentement. Après le départ du train, les employés ont comparé leurs notes pour préparer un compte rendu. Ils souhaitaient distinguer les difficultés liées au matériel de celles qui venaient de la formulation du message. Cette distinction permettrait de proposer des améliorations précises avant la prochaine période de forte fréquentation.`,
  },
  {
    name: "worker-code",
    language: "en",
    register: "code",
    text: `export async function processQueue(queue, storage, signal) {
  const completedJobs = [];
  while (!signal.aborted) {
    const job = await queue.claim({ visibilityTimeout: 30 });
    if (!job) break;
    try {
      const payload = JSON.parse(job.body);
      const previous = await storage.get(payload.recordId);
      const revision = (previous?.revision ?? 0) + 1;
      await storage.put(payload.recordId, { ...payload, revision });
      await queue.acknowledge(job.receipt);
      completedJobs.push({ id: job.id, revision });
    } catch (error) {
      await queue.retry(job.receipt, { reason: String(error) });
    }
  }
  return { completedJobs, interrupted: signal.aborted };
}`,
  },
  {
    name: "telemetry-json",
    language: "en",
    register: "json",
    text: JSON.stringify(
      {
        deployment: "east-warehouse",
        schemaVersion: 3,
        measurements: Array.from({ length: 24 }, (_, n) => ({
          timestamp: `2026-09-18T09:${String(n).padStart(2, "0")}:00Z`,
          sensorId: `temperature-${n % 5}`,
          value: 18.375 + n / 8,
          healthy: n % 7 !== 0,
          flags: n % 7 === 0 ? ["recalibrate", "inspect-cable"] : [],
        })),
        metadata: {
          timezone: "UTC",
          operator: "maintenance",
          notes: "Readings from the morning inspection.",
        },
      },
      null,
      2,
    ),
  },
];
