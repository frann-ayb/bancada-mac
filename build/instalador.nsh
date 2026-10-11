; Retoques del instalador y del desinstalador de Bancada.
;
; 1) El verbo del archivo .bancada.
;    electron-builder lo escribe en inglés ("Open with Bancada"), y ese es el
;    texto que ve el usuario al hacer clic derecho sobre un trabajo en el
;    Explorador. Acá se pisa en castellano, que es el idioma del producto.
;    customInstall corre justo después de registerFileAssociations, con el
;    SHELL_CONTEXT ya puesto (usuario o todos, según cómo se haya instalado).
;
; 2) La extensión huérfana al desinstalar.
;    El APP_UNASSOCIATE de electron-builder borra la clase pero deja
;    Software\Classes\.bancada apuntando a una clase que ya no existe: el
;    Explorador queda mostrando un tipo de archivo roto después de desinstalar.
;    Acá se limpia, pero SÓLO si la extensión sigue siendo nuestra: si el
;    usuario instaló otro programa que se quedó con el .bancada, no se toca.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\Bancada.Trabajo\shell\open" "" "Abrir con Bancada"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Bancada.Trabajo" "FriendlyTypeName" "Trabajo de Bancada"
!macroend

!macro customUnInstall
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.bancada" ""
  ${if} $0 == "Bancada.Trabajo"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.bancada" ""
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.bancada\OpenWithProgids" "Bancada.Trabajo"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.bancada\OpenWithProgids"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.bancada"
  ${endif}
!macroend
