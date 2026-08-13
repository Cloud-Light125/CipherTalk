import { Modal } from '@heroui/react'
import { RemotePhoneCard } from './RemotePhoneCard'

/** 密语 App 配对弹窗：独立于微信设备连接，侧边栏单独入口。 */
export function RemotePhoneDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          {/* heroui 最大只到 lg(32rem)，左右分栏不够宽，直接顶掉 max-width */}
          <Modal.Dialog className="max-w-3xl!">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>密语 App</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="pb-2">
                <RemotePhoneCard />
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default RemotePhoneDialog
