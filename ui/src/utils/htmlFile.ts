export const readHtmlFile = async (file: File): Promise<string> => {
  const content = await file.text();
  if (!content.trim()) {
    throw new Error('HTML 文件内容不能为空');
  }
  return content;
};
