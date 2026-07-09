const openFileBtn = document.getElementById('open-file-btn')
const filePathEl = document.getElementById('file-path')

openFileBtn.addEventListener('click', async () => {
  const filePath = await window.api.openAudioFile()

  if (filePath) {
    filePathEl.textContent = filePath
    filePathEl.classList.remove('placeholder')
  }
})
