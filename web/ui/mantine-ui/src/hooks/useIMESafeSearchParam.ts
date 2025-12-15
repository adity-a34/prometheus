import { useState, useEffect } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import {
  QueryParamConfig,
  StringParam,
  useQueryParam,
  withDefault,
} from "use-query-params";

export function useIMESafeSearchParam(
  paramName: string,
  defaultValue: string | QueryParamConfig<string | null | undefined, string | null | undefined> = ""
) {
  const [urlValue, setUrlValue] = useQueryParam(
    paramName,
    withDefault(StringParam, defaultValue)
  );

  const [localValue, setLocalValue] = useState(urlValue || "");
  const [isComposing, setIsComposing] = useState(false);

  // Sync URL → Local
  useEffect(() => {
    if (urlValue !== localValue && !isComposing) {
      setLocalValue(urlValue || "");
    }
    // localValue is intentionally omitted from the dependency array. This effect should only
    // run when the URL search param changes, to update the local input state. Including
    // localValue would cause the user's input to be overwritten.
  }, [urlValue, isComposing]);

  // Debounce and sync Local → URL
  const [debouncedValue] = useDebouncedValue(localValue, 250);

  useEffect(() => {
    // To be consistent with withDefault(StringParam, ""), we use "" instead of null.
    if (!isComposing && debouncedValue !== urlValue) {
      setUrlValue(debouncedValue || "");
    }
  }, [debouncedValue, isComposing, urlValue, setUrlValue]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(event.currentTarget.value || "");
  };

  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = (
    event: React.CompositionEvent<HTMLInputElement>
  ) => {
    setIsComposing(false);
    // Ensure final composed value is captured
    setLocalValue(event.currentTarget.value || "");
  };

  return {
    value: localValue,
    onChange: handleChange,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
    debouncedValue: debouncedValue.trim(),
  };
}
