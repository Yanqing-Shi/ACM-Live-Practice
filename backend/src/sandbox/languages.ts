export type SupportedLanguage = "cpp" | "c" | "python" | "java" | "kotlin";

export function getLanguageFromPath(
  filePath: string
): SupportedLanguage | null {
  if (filePath.endsWith(".cpp")) return "cpp";
  if (filePath.endsWith(".c")) return "c";
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".kt")) return "kotlin";

  return null;
}

export type Command = {
  argv: string[];
  env?: Record<string, string>;
};

export type LanguageContext = {
  language: SupportedLanguage;
  /** Source file as the program sees it. */
  sourcePath: string;
  /** Build directory as the program sees it. */
  buildDir: string;
  /** Path separator of the program's view ("/" inside the sandbox). */
  join: (...parts: string[]) => string;
  sandboxed: boolean;
  platform: NodeJS.Platform;
  /** Memory limit of the run step, used to size the JVM heap. */
  runMemoryMb: number;
};

function tool(context: LanguageContext, name: string): string {
  // Inside the sandbox there is no PATH lookup we want to rely on.
  return context.sandboxed ? `/usr/bin/${name}` : name;
}

function programPath(context: LanguageContext): string {
  const name =
    !context.sandboxed && context.platform === "win32" ? "program.exe" : "program";

  return context.join(context.buildDir, name);
}

function jvmFlags(context: LanguageContext): string[] {
  if (!context.sandboxed) {
    return [];
  }

  // Leave headroom under the cgroup limit for metaspace, code cache and
  // thread stacks, or the kernel kills the JVM before it can report anything.
  const heapMb = Math.max(32, context.runMemoryMb - 96);

  return ["-XX:+UseSerialGC", "-Xss64m", `-Xmx${heapMb}m`];
}

export function compileCommand(context: LanguageContext): Command | null {
  const { language, sourcePath, buildDir } = context;

  if (language === "cpp") {
    return {
      argv: [
        tool(context, "g++"),
        sourcePath,
        "-std=c++17",
        "-O2",
        "-Wall",
        "-o",
        programPath(context),
      ],
    };
  }

  if (language === "c") {
    return {
      argv: [tool(context, "gcc"), sourcePath, "-O2", "-Wall", "-o", programPath(context)],
    };
  }

  if (language === "java") {
    return {
      argv: [
        tool(context, "javac"),
        ...(context.sandboxed ? ["-J-Xmx384m", "-J-XX:+UseSerialGC", "-proc:none"] : []),
        "-d",
        buildDir,
        sourcePath,
      ],
    };
  }

  if (language === "kotlin") {
    const jar = context.join(buildDir, "program.jar");
    const args = [sourcePath, "-include-runtime", "-d", jar];

    if (context.sandboxed) {
      return {
        argv: ["/opt/kotlinc/bin/kotlinc", ...args],
        env: { JAVA_OPTS: "-Xmx512m -XX:+UseSerialGC" },
      };
    }

    if (context.platform === "win32") {
      return { argv: ["cmd.exe", "/d", "/s", "/c", "kotlinc.bat", ...args] };
    }

    return { argv: ["kotlinc", ...args] };
  }

  return null;
}

export function runCommand(
  context: LanguageContext,
  javaClassName: string
): Command {
  const { language, sourcePath, buildDir } = context;

  if (language === "python") {
    const python =
      !context.sandboxed && context.platform === "win32" ? "python" : "python3";

    return { argv: [tool(context, python), sourcePath] };
  }

  if (language === "java") {
    return {
      argv: [tool(context, "java"), ...jvmFlags(context), "-cp", buildDir, javaClassName],
    };
  }

  if (language === "kotlin") {
    return {
      argv: [
        tool(context, "java"),
        ...jvmFlags(context),
        "-jar",
        context.join(buildDir, "program.jar"),
      ],
    };
  }

  return { argv: [programPath(context)] };
}
