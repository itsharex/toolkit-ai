import { z } from 'zod';
import { readFileSync } from 'fs';
import camelCase from 'camelcase';
import Handlebars from 'handlebars';
import { format } from 'prettier';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import slugify from '@sindresorhus/slugify';
import { OpenAI, LLMChain, PromptTemplate } from 'langchain';
import { ConsoleCallbackHandler } from 'langchain/callbacks';
import { Tool, ZeroShotAgent, AgentExecutor } from 'langchain/agents';
import { SerpAPI } from 'langchain/tools';
import queryRegistry from 'query-registry';

const JsonPrimitiveSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
]);
const JsonValueSchema = z.lazy(() => z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
]));
const JsonObjectSchema = z.record(JsonValueSchema);
const GeneratedToolSchema = z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
    code: z.string(),
});
z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.optional(JsonObjectSchema),
    outputSchema: z.optional(JsonObjectSchema),
});

function resolveFromSrc(relativePath) {
    const currentFileURL = import.meta.url;
    const currentFilePath = fileURLToPath(currentFileURL);
    const currentDirPath = dirname(currentFilePath);
    const rootPath = resolve(currentDirPath, '../..');
    return join(rootPath, '/src', relativePath);
}
function readTemplate(name) {
    const path = resolveFromSrc(`templates/${name}`);
    return readFileSync(path).toString();
}

class ToolFormatter {
    tool;
    langchainTemplate;
    constructor(tool) {
        this.tool = tool;
        const langchainTemplateString = readFileSync(resolveFromSrc('templates/langchain-tool.hbs')).toString();
        this.langchainTemplate = Handlebars.compile(langchainTemplateString);
    }
    static stringifyJsonSchema(jsonSchema) {
        return JSON.stringify(jsonSchema || null, null, 2).replaceAll('\n', '\n  ');
    }
    static toLangChainDescription(description, inputSchemaString) {
        let result = description;
        if (description.slice(-1) !== '.') {
            result += '.';
        }
        result += ' The action input should adhere to this JSON schema:\n';
        result += inputSchemaString.replaceAll('{', '{{').replaceAll('}', '}}');
        return result;
    }
    toLangChain() {
        return this.langchainTemplate({
            className: camelCase(this.tool.slug, { pascalCase: true }),
            toolCode: format(this.tool.code, { parser: 'babel' }),
            toolSlug: this.tool.slug,
            langchainDescription: ToolFormatter.toLangChainDescription(this.tool.description, JSON.stringify(this.tool.inputSchema || null)),
            inputSchema: ToolFormatter.stringifyJsonSchema(this.tool.inputSchema),
            outputSchema: ToolFormatter.stringifyJsonSchema(this.tool.outputSchema),
        });
    }
    toolWithFormats() {
        return {
            ...this.tool,
            langChainCode: this.toLangChain(),
        };
    }
}

class BaseChain {
    openAIApiKey;
    logToConsole;
    chain;
    constructor(input) {
        this.openAIApiKey = input.openAIApiKey;
        this.logToConsole = input.logToConsole;
    }
    async generate(input) {
        const outputKey = this.getOutputKey();
        const chainValues = this.getChainValues(input);
        const consoleCallbackHandler = new ConsoleCallbackHandler({
            alwaysVerbose: true,
        });
        if (this.logToConsole) {
            this.chain.callbackManager.addHandler(consoleCallbackHandler);
        }
        const responseValues = await this.chain.call(chainValues);
        const responseString = responseValues[outputKey];
        if (!responseString) {
            throw new Error(`value "${outputKey}" not returned from chain call, got values: ${responseValues}`);
        }
        if (this.logToConsole) {
            this.chain.callbackManager.removeHandler(consoleCallbackHandler);
        }
        return responseString;
    }
    newLlmChain() {
        const llm = new OpenAI({
            modelName: 'gpt-4',
            temperature: 0,
            openAIApiKey: this.openAIApiKey,
        });
        const prompt = this.getPromptTemplate();
        return new LLMChain({ llm, prompt });
    }
}

const { getPackument } = queryRegistry;
class NpmInfo extends Tool {
    name = 'npm-info';
    description = 'Query NPM to fetch the README file of a particular package by name. Use this to discover implementation and usage details for a given package.';
    // eslint-disable-next-line no-underscore-dangle, class-methods-use-this
    async _call(packageName) {
        try {
            const results = await getPackument({
                name: packageName,
            });
            return results.readme || 'No details available';
        }
        catch (err) {
            return `Error: ${err}`;
        }
    }
}

const { searchPackages } = queryRegistry;
class NpmSearch extends Tool {
    name = 'npm-search';
    description = 'Search NPM to find packages given a search string. The response is an array of JSON objects including package names, descriptions, and overall quality scores.';
    // eslint-disable-next-line no-underscore-dangle, class-methods-use-this
    async _call(searchString) {
        try {
            const { objects: results } = await searchPackages({
                query: {
                    text: searchString,
                },
            });
            if (results.length < 1) {
                return 'Error: no results';
            }
            const info = results.map(({ package: { name, description }, score: { final } }) => ({
                name,
                description,
                score: final,
            }));
            return JSON.stringify(info);
        }
        catch (err) {
            return `Error: ${err}`;
        }
    }
}

/* eslint-disable class-methods-use-this */
class ExecutorChain extends BaseChain {
    serpApiKey;
    tools;
    constructor(input) {
        super(input);
        this.serpApiKey = input.serpApiKey;
        this.tools = [new NpmSearch(), new NpmInfo(), new SerpAPI(this.serpApiKey)];
        const llmChain = this.newLlmChain();
        const agent = new ZeroShotAgent({
            llmChain,
        });
        this.chain = new AgentExecutor({
            tools: this.tools,
            agent,
        });
    }
    getPromptTemplate() {
        const toolSpec = readTemplate('tool-spec.txt');
        const generateToolPrompt = Handlebars.compile(readTemplate('generate-tool-prompt.hbs'))({ toolSpec });
        const template = Handlebars.compile(readTemplate('executor-prompt.hbs'))({
            prompt: generateToolPrompt,
        });
        return new PromptTemplate({
            template,
            inputVariables: [
                'generateToolInput',
                'tools',
                'toolNames',
                'agent_scratchpad',
            ],
        });
    }
    getChainValues(input) {
        return {
            generateToolInput: JSON.stringify(input),
            tools: this.tools
                .map(({ name, description }) => `${name}: ${description}`)
                .join('\n'),
            toolNames: this.tools.map(({ name }) => name).join(', '),
        };
    }
    getOutputKey() {
        return 'output';
    }
}

/* eslint-disable class-methods-use-this */
class IteratorChain extends BaseChain {
    serpApiKey;
    tools;
    constructor(input) {
        super(input);
        this.serpApiKey = input.serpApiKey;
        this.tools = [new NpmSearch(), new NpmInfo(), new SerpAPI(this.serpApiKey)];
        const llmChain = this.newLlmChain();
        const agent = new ZeroShotAgent({
            llmChain,
        });
        this.chain = new AgentExecutor({
            tools: this.tools,
            agent,
        });
    }
    getPromptTemplate() {
        const toolSpec = readTemplate('tool-spec.txt');
        const iterateToolPrompt = Handlebars.compile(readTemplate('iterate-tool-prompt.hbs'))({
            toolSpec,
        });
        const template = Handlebars.compile(readTemplate('executor-prompt.hbs'))({
            prompt: iterateToolPrompt,
        });
        return new PromptTemplate({
            template,
            inputVariables: [
                'tool',
                'runLogs',
                'tools',
                'toolNames',
                'agent_scratchpad',
            ],
        });
    }
    getChainValues({ tool, logs }) {
        return {
            tool: JSON.stringify(tool),
            runLogs: logs,
            tools: this.tools
                .map(({ name, description }) => `${name}: ${description}`)
                .join('\n'),
            toolNames: this.tools.map(({ name }) => name).join(', '),
        };
    }
    getOutputKey() {
        return 'output';
    }
}

/* eslint-disable class-methods-use-this */
class SimpleChain extends BaseChain {
    constructor(input) {
        super(input);
        this.chain = this.newLlmChain();
    }
    getPromptTemplate() {
        const toolSpec = readTemplate('tool-spec.txt');
        const template = Handlebars.compile(readTemplate('generate-tool-prompt.hbs'))({ toolSpec });
        return new PromptTemplate({
            template,
            inputVariables: ['generateToolInput'],
        });
    }
    getChainValues(input) {
        return { generateToolInput: JSON.stringify(input) };
    }
    getOutputKey() {
        return 'text';
    }
}

class Toolkit {
    // Chain used to generate tool without use of other tools
    generatorChain;
    // Chain used to generate tool using an agent that executes other tools
    executorChain;
    iteratorChain;
    constructor(input) {
        const openAIApiKey = input?.openAIApiKey || process.env['OPENAI_API_KEY'];
        if (!openAIApiKey) {
            throw new Error('OpenAI API key not defined in params or environment');
        }
        const serpApiKey = input?.serpApiKey || process.env['SERP_API_KEY'];
        if (!serpApiKey) {
            throw new Error('Serp API key not defined in params or environment');
        }
        const logToConsole = input?.logToConsole || false;
        this.generatorChain = new SimpleChain({ openAIApiKey, logToConsole });
        this.executorChain = new ExecutorChain({
            openAIApiKey,
            serpApiKey,
            logToConsole,
        });
        this.iteratorChain = new IteratorChain({
            openAIApiKey,
            serpApiKey,
            logToConsole,
        });
    }
    // Primary public method used to generate a tool,
    // with or without an agent executing helper tools
    async generateTool(input, withExecutor = false) {
        // Call appropriate chain
        const responseString = withExecutor
            ? await this.generatorChain.generate(input)
            : await this.executorChain.generate(input);
        return this.parseResponse(responseString);
    }
    async iterateTool(input) {
        const responseString = await this.iteratorChain.generate(input);
        return this.parseResponse(responseString);
    }
    // eslint-disable-next-line class-methods-use-this
    parseResponse(responseString) {
        // Parse response into JSON object
        let responseObject;
        try {
            responseObject = JSON.parse(responseString);
        }
        catch (err) {
            throw new Error(`response could not be parsed as JSON: ${responseString}`);
        }
        // Ensure the resulting object fits expected schema
        const generatedTool = GeneratedToolSchema.parse(responseObject);
        // Add slug as an identifier
        const baseTool = {
            slug: slugify(generatedTool.name),
            ...generatedTool,
        };
        // Add formats to tool
        const tool = new ToolFormatter(baseTool).toolWithFormats();
        return tool;
    }
}

export { GeneratedToolSchema, JsonObjectSchema, JsonPrimitiveSchema, JsonValueSchema, ToolFormatter, Toolkit as default };
