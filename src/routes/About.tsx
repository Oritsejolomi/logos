import { Link } from 'react-router-dom';

export function About() {
  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-10 sm:py-16 space-y-14">
      {/* Hero */}
      <section className="space-y-4">
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">
          How this works
        </div>
        <h1 className="font-display text-4xl sm:text-5xl font-black leading-[1.05] tracking-tight text-ink-900">
          You should not trust AI<br />
          <span className="italic text-accent">with the Bible.</span>
        </h1>
        <p className="text-ink-500 text-base sm:text-lg leading-relaxed">
          We don&apos;t either. So we built this on the assumption that any
          AI-generated Bible question might be wrong, and spent a lot of effort
          making it hard for a wrong one to reach you. This page is the full
          mechanism, in plain language, with no marketing. You deserve to see
          exactly what happens between the moment you click Begin and the
          moment a question appears on your screen.
        </p>
      </section>

      {/* The honest problem — pull quote treatment */}
      <section className="space-y-5">
        <h2 className="font-display text-2xl font-bold text-ink-800">
          The honest problem
        </h2>
        <div className="border-l-2 border-accent/50 pl-5 space-y-3 text-ink-600 leading-relaxed">
          <p>
            Large language models will confidently tell you Paul wrote Hebrews,
            that Judas Iscariot and Judas Thaddaeus are the same person, or
            that the Beatitudes are in the book of Acts. They will invent
            citations. They will give you a correct answer with a wrong verse
            reference. They will do all of this in beautiful, authoritative
            prose.
          </p>
          <p>
            None of that is surprising if you work with these models.
            What&apos;s surprising is how rarely trivia apps built on them
            bother to check. Logos checks. Four times.
          </p>
        </div>
      </section>

      {/* The four gates — inline sections, no cards */}
      <section className="space-y-10">
        <h2 className="font-display text-2xl font-bold text-ink-800">
          The four gates
        </h2>

        <Gate n={1} title="Static citation validator" tagline="Free, instant, catches invented references.">
          <p>
            Before any model opinion, we parse the citation. Is{' '}
            <em>Genesis 6:14</em> real? Yes &mdash; Genesis has 50 chapters,
            chapter 6 has 22 verses. Is <em>Hezekiah 17:4</em> real? No
            &mdash; Hezekiah is a person, not a book. Is <em>Genesis 51:1</em>?
            No &mdash; Genesis has 50 chapters. Rejected.
          </p>
          <p>
            This gate uses a hardcoded map of every book, chapter, and verse
            count in the 66-book Protestant canon. It&apos;s boring. It
            catches the largest category of AI failures with zero model calls.
          </p>
        </Gate>

        <Gate n={2} title="Option quality check" tagline="No parenthetical giveaways, no stem-echoing.">
          <p>
            Two ways AI gives away an answer it doesn&apos;t realise it&apos;s
            giving away. First: it sticks the definition inside the option
            itself. <em>&ldquo;Immutability (unchanging).&rdquo;</em> Game
            over. Second: it echoes a distinctive word from the question into
            the correct option, so the answer is findable by word matching
            alone. Both happen constantly if you don&apos;t watch for them.
          </p>
          <p>
            We reject any question with parentheses in an option, and any
            question where a meaningful word in the stem appears in an
            option. It&apos;s a crude rule. It also turns out to be worth its
            weight in gold.
          </p>
        </Gate>

        <Gate n={3} title="LLM-as-judge with the real Bible text" tagline="A second pass that reads the actual verse.">
          <p>
            Now it gets interesting. After the first model generates the
            question, a second model call at low temperature reviews it.
            That reviewer&apos;s prompt includes the question, the four
            options, the claimed correct answer, the citation,{' '}
            <strong className="text-ink-800">and the actual verse text pulled from three
            public-domain Bibles</strong> in our Postgres database (WEB, KJV,
            ASV &mdash; 93,283 verses across the three).
          </p>
          <p>
            The judge returns one of four verdicts: <em>correct</em>,{' '}
            <em>wrong_answer</em> (with a corrected index),{' '}
            <em>wrong_citation</em>, or <em>ambiguous</em>. Anything other
            than <em>correct</em> is auto-corrected or rejected. Three
            witnesses rather than one means translation-sensitive questions
            get flagged as ambiguous instead of forced through.
          </p>
        </Gate>

        <Gate n={4} title="Early skepticism + community moderation" tagline="One flag kills a brand-new question.">
          <p>
            Established questions &mdash; the ones players have seen and
            accepted over many games &mdash; need three flags before
            they&apos;re pulled. Brand-new questions (played three times or
            fewer) are pulled on the very first flag. Be paranoid about new
            content, forgiving about vetted content.
          </p>
          <p>
            So if you see something that feels off, please flag it. The
            button is in the top-right of the insight card after you answer.
            You are genuinely part of the quality system &mdash; not in the
            &ldquo;user feedback&rdquo; sense, but in the sense that your
            click actually removes the question from circulation.
          </p>
        </Gate>
      </section>

      {/* Doctrinal basis */}
      <section className="space-y-4">
        <h2 className="font-display text-2xl font-bold text-ink-800">
          What we base doctrine on
        </h2>
        <p className="text-ink-600 leading-relaxed">
          Logos is built on <em>sola scriptura</em>: Scripture alone is
          authoritative, and every correct answer must be pinned to a
          specific book, chapter, and verse in the 66-book Protestant canon.
          That&apos;s a choice with consequences worth stating plainly.
        </p>
        <p className="text-ink-600 leading-relaxed">It means we do not defer to:</p>
        <ul className="list-disc pl-6 text-ink-600 space-y-1.5 leading-relaxed">
          <li>Church tradition rulings (Catholic, Orthodox, Reformed, Wesleyan, or anyone else)</li>
          <li>Extra-biblical writings, even valuable ones like the Didache, the early creeds, or Augustine</li>
          <li>Denominational distinctives like predestination mechanics, baptism mode, or eschatological particulars</li>
          <li>Systematic theology that isn&apos;t directly rooted in a named verse</li>
        </ul>
        <p className="text-ink-600 leading-relaxed">
          If a topic is genuinely disputed across Scripture &mdash; say, the
          precise relationship between divine sovereignty and human will, or
          the order of events in Revelation &mdash; our system prompt
          instructs the model{' '}
          <strong className="text-ink-800">not to generate a question on it</strong>.
          We&apos;d rather serve no question than one that forces a position
          the text itself doesn&apos;t force.
        </p>
        <p className="text-ink-500 italic leading-relaxed">
          If you think we&apos;ve drawn this line in the wrong place, you are
          almost certainly worth reading. Open an issue on GitHub and tell us
          why.
        </p>
      </section>

      {/* Translations — plain table, no card wrapper */}
      <section className="space-y-5">
        <h2 className="font-display text-2xl font-bold text-ink-800">
          About the translations
        </h2>
        <p className="text-ink-600 leading-relaxed">
          The RAG gate currently uses three public-domain translations,
          shipped with the app:
        </p>
        <dl className="space-y-2.5">
          <TranslationRow name="WEB" full="World English Bible" detail="Public domain, modern English, 31,095 verses" included />
          <TranslationRow name="KJV" full="King James Version" detail="Public domain, 1611/1769 revision, 31,102 verses" included />
          <TranslationRow name="ASV" full="American Standard Version" detail="Public domain, 1901, 31,086 verses" included />
        </dl>

        <p className="text-ink-600 leading-relaxed pt-3">
          The translations you won&apos;t find here, and why:
        </p>
        <dl className="space-y-2.5">
          <TranslationRow name="NIV" full="New International Version" detail="© Biblica / Zondervan — commercial license required" />
          <TranslationRow name="NKJV" full="New King James Version" detail="© HarperCollins Christian Publishing — commercial license required" />
          <TranslationRow name="NLT" full="New Living Translation" detail="© Tyndale House — commercial license required" />
          <TranslationRow name="AMP" full="Amplified Bible" detail="© Lockman Foundation — commercial license required" />
          <TranslationRow name="MSG" full="The Message" detail="© NavPress — commercial license required" />
        </dl>
        <p className="text-ink-600 leading-relaxed pt-1">
          We&apos;d love to include them. Each requires a commercial license
          from the publisher, and those licenses are not typically granted to
          free community-run projects. If you have a relationship with one of
          these publishers and want to help open a conversation, please do.
        </p>
      </section>

      {/* Contribute */}
      <section className="space-y-4">
        <h2 className="font-display text-2xl font-bold text-ink-800">
          Contribute
        </h2>
        <p className="text-ink-600 leading-relaxed">
          Logos is open source. If you spot a bad question, flag it in-game.
          If you want to improve the gates, the prompts, the UI, the scoring,
          or add a new translation, the repo is on GitHub and pull requests
          are welcome. The biggest quality improvements are likely to come
          from sharper option-quality heuristics and richer cross-session
          diversity.
        </p>
        <div className="pt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <a
            href="https://github.com/Oritsejolomi/logos"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline font-medium"
          >
            GitHub repo →
          </a>
          <a
            href="https://github.com/Oritsejolomi/logos/blob/main/README.md#contributing"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline font-medium"
          >
            Contribution targets →
          </a>
        </div>
      </section>

      <div className="pt-2 border-t border-rule/50">
        <Link to="/" className="inline-block pt-6 text-sm text-accent hover:underline">
          ← Back to home
        </Link>
      </div>
    </div>
  );
}

function Gate({ n, title, tagline, children }: {
  n: number;
  title: string;
  tagline: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-accent font-bold tabular-nums">Gate {n}</span>
        <h3 className="font-display text-xl font-bold text-ink-800">{title}</h3>
      </div>
      <div className="text-[11px] uppercase tracking-[0.2em] text-ink-400">
        {tagline}
      </div>
      <div className="text-ink-600 leading-relaxed space-y-3 text-sm sm:text-base">
        {children}
      </div>
    </div>
  );
}

function TranslationRow({ name, full, detail, included }: {
  name: string;
  full: string;
  detail: string;
  included?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <dt className="font-mono text-xs font-bold text-accent w-12 tabular-nums">{name}</dt>
      <dd className="flex-1 min-w-0">
        <span className="text-ink-800 font-medium">{full}</span>
        <span className="text-ink-400 ml-2">{detail}</span>
      </dd>
      {included && (
        <span className="text-[10px] uppercase tracking-wider font-semibold text-yes whitespace-nowrap">
          Included
        </span>
      )}
    </div>
  );
}
