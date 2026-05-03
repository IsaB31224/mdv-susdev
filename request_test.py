import os
import anthropic
from dotenv import load_dotenv

load_dotenv()

client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))


def parse_sentences(text: str) -> list[str]:
    sentences = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line[0].isdigit():
            parts = line.split(".", 1)
            if len(parts) > 1:
                line = parts[1].strip()
        sentences.append(line)
    return sentences


def get_shortest_sentence(sentences: list[str]) -> str:
    return min(sentences, key=len)


def get_similar_sentences(input_sentence: str) -> list[str]:
    prompt = f"""Generate 10 semantically similar sentences to the following sentence.
Make them as short as possible.

Sentence: "{input_sentence}"

Return ONLY a numbered list of 10 sentences."""

    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    return parse_sentences(message.content[0].text)


def run_test(user_input: str) -> str:
    import time
    start = time.time()

    sentences = get_similar_sentences(user_input)
    output = ""

    if len(sentences) < 10:
        output += "Warning: fewer than 10 sentences returned\n"

    shortest = get_shortest_sentence(sentences)

    output += "\nGenerated sentences:\n"
    for s in sentences:
        output += f"- {s}\n"

    output += "\nShortest sentence:\n"
    output += shortest + "\n"
    output += f"took {time.time() - start:.3f}s\n"

    return output


if __name__ == "__main__":
    user_input = input("Enter a sentence: ")
    print(run_test(user_input))
