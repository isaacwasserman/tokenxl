import type { TuningDocument } from "./selection.ts";

/**
 * Authored running text for the language rules that the benchmark texts do
 * not cover. Accent rules are fitted on running text only, so each needs prose
 * in its languages. German is covered by Die Verwandlung.
 */
export const LANGUAGE_DOCUMENTS: readonly TuningDocument[] = [
  {
    name: "archives-fr",
    language: "fr",
    register: "prose",
    text: `Le service des archives municipales a terminé l'inventaire des registres anciens. Pendant trois semaines, deux bibliothécaires ont vérifié chaque volume, noté son état et photographié les pages abîmées. Certains cahiers avaient souffert de l'humidité ; d'autres étaient presque intacts. Les documents les plus fragiles ont été placés dans des boîtes neuves, à l'abri de la lumière. L'équipe a aussi découvert une série de plans de quartiers dessinés à la main au début du siècle dernier. Ces plans montrent des rues qui n'existent plus et des jardins remplacés depuis longtemps par des immeubles. Une historienne de l'université a proposé de les étudier avant leur numérisation. Le rapport final recommande de prévoir un budget pour la restauration et de former les agents à la manipulation des documents. Il précise également que la salle de lecture restera fermée jusqu'à la fin du mois, le temps d'installer un nouveau système de ventilation.`,
  },
  {
    name: "library-es",
    language: "es",
    register: "prose",
    text: `El ayuntamiento presentó ayer el plan para renovar la biblioteca del barrio. Según el informe, el edificio necesita un tejado nuevo, ventanas más eficientes y una rampa de acceso para personas con movilidad reducida. Las obras comenzarán en primavera y durarán unos ocho meses. Durante ese tiempo, una parte de la colección se trasladará al centro cultural, donde los lectores podrán pedir libros y usar los ordenadores. Los vecinos pidieron que se mantuviera el horario de tarde, porque muchos estudiantes acuden después de las clases. La directora explicó que también se ampliará la sala infantil y que habrá un espacio para talleres de lectura. Al final de la reunión, varios asistentes preguntaron por el coste total y por la posibilidad de reutilizar los muebles antiguos.`,
  },
  {
    name: "bridge-pl",
    language: "pl",
    register: "prose",
    text: `W poniedziałek rano zespół techniczny sprawdził stan mostu nad rzeką. Po ostatnich ulewach woda podniosła się o prawie metr i zalała część ścieżki rowerowej. Inżynierowie zmierzyli głębokość, obejrzeli filary i wykonali zdjęcia pęknięć w betonie. Większość uszkodzeń okazała się powierzchowna, ale jedno z łożysk wymaga szybkiej wymiany. Do czasu naprawy ruch samochodów ciężarowych zostanie ograniczony, a piesi będą mogli korzystać z tymczasowej kładki. Mieszkańcy pytali, jak długo potrwają prace i czy autobusy zmienią trasę. Urzędnicy odpowiedzieli, że harmonogram zależy od dostawy części, ale postarają się zakończyć remont przed zimą. Szczegółowy raport zostanie opublikowany na stronie internetowej gminy.`,
  },
  {
    name: "reading-club-cs",
    language: "cs",
    register: "prose",
    text: `Ve čtvrtek odpoledne se v knihovně konalo setkání čtenářského klubu. Účastníci diskutovali o románu, který vypráví příběh rodiny žijící na malém statku v horách. Někteří oceňovali přesné popisy krajiny a každodenní práce, jiní považovali děj za příliš pomalý. Knihovnice připravila krátký přehled autorova života a ukázala fotografie míst, kde se příběh odehrává. Po diskusi si členové klubu vybrali knihu na příští měsíc. Rozhodli se pro sbírku povídek, protože se dá číst po částech i během krátkých cest vlakem. Na závěr se domluvili, že příští setkání proběhne ve větší místnosti, aby se mohli připojit i noví čtenáři.`,
  },
  {
    name: "park-ru",
    language: "ru",
    register: "prose",
    text: `Во вторник в городском парке начали высаживать новые деревья. Садовники выбрали клёны и липы, которые хорошо переносят жаркое лето и холодную зиму. Перед посадкой они проверили почву, добавили удобрения и установили опоры для молодых саженцев. Жители района помогали поливать деревья и собирать мусор вокруг пруда. Руководитель проекта рассказал, что в следующем году появятся новые скамейки и освещение вдоль главной аллеи. Некоторые посетители предложили сделать отдельную площадку для собак, чтобы животные не мешали детям. Администрация обещала рассмотреть это предложение после того, как будут подведены итоги опроса.`,
  },
  {
    name: "harbor-el",
    language: "el",
    register: "prose",
    text: `Την Τετάρτη το πρωί οι εργαζόμενοι του λιμανιού έλεγξαν τις νέες γερανογέφυρες. Οι μηχανικοί μέτρησαν την ταχύτητα φόρτωσης και κατέγραψαν τα σημεία όπου χρειάζονται μικρές ρυθμίσεις. Παράλληλα, η ομάδα ασφαλείας εξήγησε στους οδηγούς φορτηγών τη νέα διαδρομή μέσα στην αποβάθρα. Το σύστημα παρακολούθησης στέλνει πλέον ειδοποιήσεις όταν ένα κοντέινερ μένει περισσότερο από δύο ημέρες στον ίδιο χώρο. Οι διαχειριστές πιστεύουν ότι η αλλαγή θα μειώσει τις καθυστερήσεις κατά τους καλοκαιρινούς μήνες. Η τελική αξιολόγηση θα παρουσιαστεί στο συμβούλιο του λιμανιού στο τέλος του μήνα.`,
  },
];
