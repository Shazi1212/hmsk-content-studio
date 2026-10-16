/**
 * Provider adapters for the content pipeline. Import from "@/lib/providers".
 *
 *   providerStatus()                      which providers have keys (for the UI status dots)
 *   generateText(req)                     text / script generation (local | openai | gemini | anthropic | mock)
 *   synthesizeVoice(p), listVoices()      ElevenLabs
 *   createVideoJob(p), getVideoJob(id)    Higgsfield
 *   generateImage(p)                      Gemini image model
 *   ProviderNotConfiguredError, ProviderRequestError, isProviderError
 */
export * from "./config";
export * from "./text";
export * from "./audio";
export * from "./video";
export * from "./image";
