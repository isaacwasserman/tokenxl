import type { TuningDocument } from "./selection.ts";

/**
 * Running text for the language rules that the benchmark texts do not cover:
 * authored paragraphs, and a literary French excerpt. The scales of unaccented
 * words are fitted on running text only, so each accent rule needs prose in
 * its languages. German is covered by Die Verwandlung.
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
  {
    name: "voyage-centre-terre-fr",
    language: "fr",
    register: "prose",
    text: "Le 24 mai 1863, un dimanche, mon oncle, le professeur Lidenbrock, revint précipitamment vers sa petite maison située au numéro 19 de König-strasse, l'une des plus anciennes rues du vieux quartier de Hambourg.\n\nLa bonne Marthe dut se croire fort en retard, car le dîner commençait à peine à chanter sur le fourneau de la cuisine.\n\n«Bon, me dis-je, s'il a faim, mon oncle, qui est le plus impatient des hommes, va pousser des cris de détresse.\n\n—Déja M. Lidenbrock! s'écria la bonne Marthe stupéfaite, en entre-bâillant la porte de la salle à manger.\n\n—Oui, Marthe; mais le dîner a le droit de ne point être cuit, car il n'est pas deux heures. La demie vient à peine de sonner à Saint-Michel.\n\n—Alors pourquoi M. Lidenbrock rentre-t-il?\n\n—Il nous le dira vraisemblablement.\n\n—Le voilà! je me sauve. Monsieur Axel, vous lui ferez entendre raison.»\n\nEt la bonne Marthe regagna son laboratoire culinaire.\n\nJe restai seul. Mais de faire entendre raison au plus irascible des professeurs, c'est ce que mon caractère un peu indécis ne me permettait pas. Aussi je me préparais à regagner prudemment ma petite chambre du haut, quand la porte de la rue cria sur ses gonds; de grands pieds firent craquer l'escalier de bois, et le maître de la maison, traversant la salle à manger, se précipite aussitôt dans son cabinet de travail.\n\nMais, pendant ce rapide passage, il avait jeté dans un coin sa canne à tête de casse-noisette, sur la table son large chapeau à poils rebroussés et à son neveu ces paroles retentissantes:\n\n«Axel, suis-moi!»\n\nJe n'avais pas eu le temps de bouger que le professeur me criait déjà avec un vif accent d'impatience:\n\n«Eh bien! tu n'es pas encore ici?»\n\nJe m'élançai dans le cabinet de mon redoutable maître.\n\nOtto Lidenbrock n'était pas un méchant homme, j'en conviens volontiers; mais, à moins de changements improbables, il mourra dans la peau d'un terrible original.\n\nIl était professeur au Johannaeum, et faisait un cours de minéralogie pendant lequel il se mettait régulièrement en colère une fois ou deux. Non point qu'il se préoccupât d'avoir des élèves assidus à ses leçons, ni du degré d'attention qu'ils lui accordaient, ni du succès qu'ils pouvaient obtenir par la suite; ces détails ne l'inquiétaient guère. Il professait «subjectivement», suivant une expression de la philosophie allemande, pour lui et non pour les autres. C'était un savant égoïste, un puits de science dont la poulie grinçait quand on en voulait tirer quelque chose. En un mot, un avare.\n\nIl y a quelques professeurs de ce genre en Allemagne.\n\nMon oncle, malheureusement, ne jouissait pas d'une extrême facilité de prononciation, sinon dans l'intimité, au moins quand il parlait en public, et c'est un défaut regrettable chez un orateur. En effet, dans ses démonstrations au Johannaeum, souvent le professeur s'arrêtait court; il luttait contre un mot récalcitrant qui ne voulait pas glisser entre ses lèvres, un de ces mots qui résistent, se gonflent et finissent par sortir sous la forme peu scientifique d'un juron. De là, grande colère.\n\nIl y a en minéralogie bien des dénominations semi-grecques, semi-latines, difficiles à prononcer, de ces rudes appellations qui écorcheraient les lèvres d'un poète. Je ne veux pas dire du mal de cette science. Loin de moi. Mais lorsqu'on se trouve en présence des cristallisations rhomboédriques, des résines rétinasphaltes, des ghélénites, des tangasites, des molybdates de plomb, des tungstates de manganèse et des titaniates de zircone, il est permis à la langue la plus adroite de fourcher.\n\nOr, dans la ville, on connaissait cette pardonnable infirmité de mon oncle, et on, en abusait, et on l'attendait aux passages dangereux, et il se mettait en fureur, et l'on riait, ce qui n'est pas de bon goût, même pour des Allemands. S'il y avait donc toujours grande affluence d'auditeurs aux cours de Lidenbrock, combien les suivaient assidûment qui venaient surtout pour se dérider aux belles colères du professeur!",
  },
];
