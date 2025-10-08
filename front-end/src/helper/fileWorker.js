// fileWorker.js

self.onmessage = async (e) => {
  const { fileData, chunkSize } = e.data;

  // Recreate the File object from data
  const file = new File([fileData.buffer], fileData.name, { type: fileData.type });
  const totalSize = file.size;
  let offset = 0;

  while (offset < totalSize) {
    const slice = file.slice(offset, offset + chunkSize);
    const buffer = await slice.arrayBuffer();

    // Send chunk back to main thread
    postMessage({ chunk: buffer, offset }, [buffer]);
    offset += chunkSize;
  }

  postMessage({ done: true });
};
