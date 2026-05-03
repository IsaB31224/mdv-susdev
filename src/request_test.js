const API_URL = "https://router.huggingface.co/v1/chat/completions";
const API_KEY = process.env.VITE_HF_API_KEY || "";

export function parseSentences(text) {
    const lines = text.split("\n");
    const sentences = [];

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        if (/^\d/.test(line)) {
            const parts = line.split(".");
            if (parts.length > 1) {
                line = parts.slice(1).join(".").trim();
            }
        }
        sentences.push(line);
    }
    return sentences;
}

export function getShortestSentence(sentences) {
    return sentences.reduce((a, b) => a.length <= b.length ? a : b);
}

export async function getSimilarSentences(inputSentence) {
    const prompt = `
    Generate 10 semantically similar sentences to the following sentence.
    make them as short as possible.

    Sentence: "${inputSentence}"

    Return ONLY a numbered list of 10 sentences.
    `;

    const headers = {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
    };

    const payload = {
        messages: [
            {
                role: "user",
                content: prompt
            }
        ],
        model: "meta-llama/Llama-3.1-8B-Instruct:novita"
    };

    const response = await fetch(API_URL, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content;

    return parseSentences(text);
}

export async function runTest(userInput, outputElement) {
    const start = performance.now();
    try {
        const sentences = await getSimilarSentences(userInput);
        
        let output = "";
        if (sentences.length < 10) {
            output += "Warning: fewer than 10 sentences returned\n";
        }

        const shortest = getShortestSentence(sentences);

        output += "\nGenerated sentences:\n";
        for (const s of sentences) {
            output += `- ${s}\n`;
        }

        output += "\nShortest sentence:\n";
        output += shortest + "\n";
        const end = performance.now();
        output += `took ${(end - start) / 1000}s\n`;
        
        if (outputElement) {
            outputElement.textContent = output;
        } else {
            console.log(output);
        }

    } catch (e) {
        console.error("Error:", e);
        if (outputElement) {
            outputElement.textContent = `Error: ${e.message}`;
        }
    }
}
